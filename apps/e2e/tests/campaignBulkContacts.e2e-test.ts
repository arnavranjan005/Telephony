// Bulk campaign contact creation against real Postgres. Proves the 3-step
// bulk path (createMany -> findMany -> createMany) links existing leads, links
// pre-existing ones by phone without duplicating them, de-dupes a number that
// arrives as both a picked leadId and a typed phone, and that consentGrantedAll
// grants consent to every lead in the campaign.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, ConsentStatus } from "@telephony/database";

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

describe("campaign bulk contacts e2e (real Postgres)", () => {
  it("links existing leads (by id and by phone) and creates new ones, de-duped", async () => {
    const e1 = await prisma.lead.create({ data: { phoneNumber: "+15551000001", name: "Existing One" } });
    const e2 = await prisma.lead.create({ data: { phoneNumber: "+15551000002" } });

    const res = await request(app)
      .post("/api/campaigns")
      .send({
        name: "bulk mix",
        script: "Ask about renewal",
        contacts: [
          { leadId: e1.id }, // picked existing lead
          { phoneNumber: "+15551000001" }, // SAME lead by phone -> must de-dupe with the leadId entry
          { phoneNumber: "+15551000002" }, // other existing lead, by phone -> linked, not duplicated
          { phoneNumber: "+15551000003", name: "New" }, // brand new
          { phoneNumber: "+15551000003" }, // same new number twice -> one
        ],
      });

    expect(res.status).toBe(201);
    // e1, e2, new1 -> exactly 3 unique contacts.
    expect(res.body.campaign.contacts).toHaveLength(3);
    const linkedLeadIds = new Set(res.body.campaign.contacts.map((c: { leadId: string }) => c.leadId));
    expect(linkedLeadIds.has(e1.id)).toBe(true);
    expect(linkedLeadIds.has(e2.id)).toBe(true);

    // No duplicate leads: the two existing + one new = 3 total.
    expect(await prisma.lead.count()).toBe(3);
    expect(await prisma.lead.count({ where: { phoneNumber: "+15551000001" } })).toBe(1);
    // The new lead kept its name from the first occurrence.
    const created = await prisma.lead.findUniqueOrThrow({ where: { phoneNumber: "+15551000003" } });
    expect(created.name).toBe("New");
  });

  it("consentGrantedAll grants consent to every lead in the campaign", async () => {
    const existing = await prisma.lead.create({ data: { phoneNumber: "+15552000001" } });
    expect(existing.consentStatus).toBe(ConsentStatus.UNKNOWN);

    const res = await request(app)
      .post("/api/campaigns")
      .send({
        name: "consent all",
        script: "Ask about renewal",
        contacts: [{ leadId: existing.id }, { phoneNumber: "+15552000002" }],
        consentGrantedAll: true,
      });

    expect(res.status).toBe(201);
    const leads = await prisma.lead.findMany();
    expect(leads).toHaveLength(2);
    for (const lead of leads) {
      expect(lead.consentStatus).toBe(ConsentStatus.GRANTED);
      expect(lead.consentSource).toBe("campaign");
      expect(lead.consentedAt).toBeInstanceOf(Date);
    }
  });

  it("leaves consent UNKNOWN when the toggle is off", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "no consent", script: "Ask", contacts: [{ phoneNumber: "+15553000001" }] });

    expect(res.status).toBe(201);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { phoneNumber: "+15553000001" } });
    expect(lead.consentStatus).toBe(ConsentStatus.UNKNOWN);
  });

  it("handles a large contact list in one create (bulk, not per-row)", async () => {
    const contacts = Array.from({ length: 250 }, (_, i) => ({ phoneNumber: `+1557${String(i).padStart(7, "0")}` }));
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "big", script: "Ask", contacts, consentGrantedAll: true });

    expect(res.status).toBe(201);
    expect(res.body.campaign.contacts).toHaveLength(250);
    expect(await prisma.lead.count()).toBe(250);
    expect(await prisma.lead.count({ where: { consentStatus: ConsentStatus.GRANTED } })).toBe(250);
  });
});
