// Adding contacts to an existing DRAFT campaign against real Postgres. This
// is the endpoint the Leads CSV import dialog calls when the user opts to
// also attach the imported leads to a campaign they've already drafted.
// Exercises the DRAFT-only gate, the @@unique([campaignId, leadId])
// constraint that makes a lead already in the campaign get skipped (not
// duplicated), and consent granting.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, ConsentStatus } from "@telephony/database";
import { dialQueue, campaignContactJobId } from "@telephony/queue";

const app = createApp();

afterAll(async () => {
  // Obliterate (not just close) - the last test in this file enqueues a real
  // job onto the shared dial queue; leftover jobs could otherwise bleed into
  // the next e2e file run within the same --runInBand invocation.
  await dialQueue.obliterate({ force: true });
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.conversationMessage.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.campaignContact.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.call.deleteMany();
  await prisma.dncEntry.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.idempotencyKey.deleteMany();
});

async function createDraftCampaign() {
  const res = await request(app).post("/api/campaigns").send({ name: "Q3 renewals", script: "Ask about renewal" });
  return res.body.campaign.id as string;
}

describe("add contacts to campaign e2e (real Postgres)", () => {
  it("links new and existing leads to a DRAFT campaign", async () => {
    const campaignId = await createDraftCampaign();
    const existing = await prisma.lead.create({ data: { phoneNumber: "+15556660001", firstName: "Existing" } });

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ leadId: existing.id }, { phoneNumber: "+15556660002", firstName: "New" }] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 2, alreadyInCampaign: 0 });
    expect(res.body.campaign.contacts).toHaveLength(2);
    expect(await prisma.lead.count()).toBe(2); // no duplicate lead created for `existing`
  });

  it("skips a lead already in the campaign instead of double-linking it", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15556660003" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });

    // Re-import a CSV containing the same lead (by phone) plus one new number.
    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ phoneNumber: "+15556660003" }, { phoneNumber: "+15556660004" }] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ added: 1, alreadyInCampaign: 1 });
    // Exactly one contact row for the repeated lead - not two.
    expect(await prisma.campaignContact.count({ where: { campaignId, leadId: lead.id } })).toBe(1);
    expect(await prisma.campaignContact.count({ where: { campaignId } })).toBe(2);
  });

  it("rejects adding contacts to a campaign that already started", async () => {
    const campaignId = await createDraftCampaign();
    await request(app).post(`/api/campaigns/${campaignId}/start`);

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ phoneNumber: "+15556660005" }] });

    expect(res.status).toBe(409);
    expect(await prisma.campaignContact.count({ where: { campaignId } })).toBe(0);
  });

  it("404s for a campaign that doesn't exist", async () => {
    const res = await request(app)
      .post("/api/campaigns/does-not-exist/contacts")
      .send({ contacts: [{ phoneNumber: "+15556660006" }] });

    expect(res.status).toBe(404);
  });

  it("grants consent to every resolved lead when consentGrantedAll is set", async () => {
    const campaignId = await createDraftCampaign();
    const existing = await prisma.lead.create({ data: { phoneNumber: "+15556660007" } });

    const res = await request(app)
      .post(`/api/campaigns/${campaignId}/contacts`)
      .send({
        contacts: [{ leadId: existing.id }, { phoneNumber: "+15556660008" }],
        consentGrantedAll: true,
      });

    expect(res.status).toBe(201);
    const leads = await prisma.lead.findMany();
    expect(leads).toHaveLength(2);
    for (const lead of leads) {
      expect(lead.consentStatus).toBe(ConsentStatus.GRANTED);
      expect(lead.consentSource).toBe("campaign");
    }
  });

  it("rejects an empty contacts array", async () => {
    const campaignId = await createDraftCampaign();
    const res = await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [] });
    expect(res.status).toBe(400);
  });

  it(
    "proves the DRAFT claim is atomic: racing an attach against starting the campaign never strands a contact un-enqueued",
    async () => {
      const campaignId = await createDraftCampaign();

      // Fire both concurrently against the real Postgres instance - only the
      // atomic conditional updateMany claim inside addContactsToCampaign
      // should let one of these two orderings actually happen:
      //  (a) the attach commits first (still DRAFT) -> start then runs, sees
      //      the freshly committed contact as PENDING, and enqueues it, or
      //  (b) start commits first -> the attach's own claim then correctly
      //      finds the campaign no longer DRAFT and is rejected with 409,
      //      having inserted nothing.
      // What must never happen is a third outcome: the attach succeeding
      // while a contact is left PENDING on an already-RUNNING campaign
      // without ever being enqueued - the interleaving this test guards
      // against (see the doc comment on the updateMany claim in
      // campaignService.ts).
      const [attachRes] = await Promise.all([
        request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ phoneNumber: "+15556660009" }] }),
        request(app).post(`/api/campaigns/${campaignId}/start`),
      ]);

      const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });

      if (attachRes.status === 201) {
        expect(contacts).toHaveLength(1);
        const job = await dialQueue.getJob(campaignContactJobId(contacts[0].id));
        expect(job).not.toBeNull();
      } else {
        expect(attachRes.status).toBe(409);
        expect(contacts).toHaveLength(0);
      }
    },
    15000
  );
});
