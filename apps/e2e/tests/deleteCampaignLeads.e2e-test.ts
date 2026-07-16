// Deleting all leads attached to a DRAFT campaign, against real Postgres.
// The interesting behavior here is entirely DB-constraint-driven: a lead
// with call/appointment/follow-up history, or attached to another campaign
// too, can't be deleted without touching that other data - Postgres itself
// would reject it (no cascade is configured on those relations on purpose).
// This proves each of those cases gets skipped rather than erroring out the
// whole batch, and that a genuinely clean lead does get deleted.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, CallDirection } from "@telephony/database";

const app = createApp();

afterAll(async () => {
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
  const res = await request(app).post("/api/campaigns").send({ name: "Cleanup test", script: "Ask about renewal" });
  return res.body.campaign.id as string;
}

describe("delete campaign leads e2e (real Postgres)", () => {
  it("deletes a clean lead (no history, only this campaign) and removes its contact row", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770001", name: "Clean Co" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: 1, skipped: 0 });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).toBeNull();
    expect(await prisma.campaignContact.count({ where: { campaignId } })).toBe(0);
  });

  it("skips a lead that has call history instead of erroring out the batch", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770002", name: "Has Call" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });
    await prisma.call.create({
      data: { direction: CallDirection.OUTBOUND, fromNumber: "+15550000000", toNumber: lead.phoneNumber, leadId: lead.id },
    });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedLeads: [{ id: lead.id, name: "Has Call", phoneNumber: lead.phoneNumber, reason: "1 call" }],
    });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    expect(await prisma.campaignContact.count({ where: { campaignId } })).toBe(1);
  });

  it("skips a lead that has an appointment", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770003", name: "Has Appt" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });
    await prisma.appointment.create({
      data: {
        title: "Consult",
        startTime: new Date(Date.now() + 3600_000),
        endTime: new Date(Date.now() + 7200_000),
        leadId: lead.id,
      },
    });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.body).toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedLeads: [{ id: lead.id, reason: "1 appointment" }],
    });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });

  it("skips a lead that has a follow-up", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770004", name: "Has Followup" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });
    await prisma.followUp.create({
      data: { leadId: lead.id, scheduledAt: new Date(Date.now() + 3600_000) },
    });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.body).toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedLeads: [{ id: lead.id, reason: "1 follow-up" }],
    });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });

  it("skips a lead that's also attached to another campaign", async () => {
    const campaignId = await createDraftCampaign();
    const otherCampaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770005", name: "In Two Campaigns" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });
    await request(app).post(`/api/campaigns/${otherCampaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.body).toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedLeads: [{ id: lead.id, reason: "in 1 other campaign" }],
    });
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    // Untouched in both campaigns - not just left in the other one.
    expect(await prisma.campaignContact.count({ where: { leadId: lead.id } })).toBe(2);
  });

  it("deletes clean leads while skipping the ones with history in the same batch", async () => {
    const campaignId = await createDraftCampaign();
    const clean = await prisma.lead.create({ data: { phoneNumber: "+15557770006", name: "Clean" } });
    const withCall = await prisma.lead.create({ data: { phoneNumber: "+15557770007", name: "With Call" } });
    await request(app)
      .post(`/api/campaigns/${campaignId}/contacts`)
      .send({ contacts: [{ leadId: clean.id }, { leadId: withCall.id }] });
    await prisma.call.create({
      data: { direction: CallDirection.OUTBOUND, fromNumber: "+15550000000", toNumber: withCall.phoneNumber, leadId: withCall.id },
    });

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.body).toMatchObject({ deleted: 1, skipped: 1 });
    expect(await prisma.lead.findUnique({ where: { id: clean.id } })).toBeNull();
    expect(await prisma.lead.findUnique({ where: { id: withCall.id } })).not.toBeNull();
  });

  it("is a no-op when the campaign has no contacts", async () => {
    const campaignId = await createDraftCampaign();
    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: 0, skipped: 0 });
  });

  it("rejects deleting leads from a campaign that already started", async () => {
    const campaignId = await createDraftCampaign();
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15557770008" } });
    await request(app).post(`/api/campaigns/${campaignId}/contacts`).send({ contacts: [{ leadId: lead.id }] });
    await request(app).post(`/api/campaigns/${campaignId}/start`);

    const res = await request(app).delete(`/api/campaigns/${campaignId}/contacts`);

    expect(res.status).toBe(409);
    expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });

  it("404s for a campaign that doesn't exist", async () => {
    const res = await request(app).delete("/api/campaigns/does-not-exist/contacts");
    expect(res.status).toBe(404);
  });
});
