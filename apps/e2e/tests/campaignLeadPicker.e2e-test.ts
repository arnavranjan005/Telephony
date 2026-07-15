// Building a campaign from existing leads against real Postgres. The campaign
// lead picker in the admin panel sends selected leads by id; this proves the
// API links the existing lead (rather than upserting a duplicate) and still
// accepts typed ad-hoc numbers alongside them.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma } from "@telephony/database";

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

describe("campaign from existing leads e2e (real Postgres)", () => {
  it("links an existing lead by id instead of creating a duplicate", async () => {
    const lead = await prisma.lead.create({
      data: { phoneNumber: "+15551110001", name: "Existing Lead" },
    });

    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "picker campaign", script: "Ask about renewal", contacts: [{ leadId: lead.id }] });

    expect(res.status).toBe(201);
    expect(res.body.campaign.contacts).toHaveLength(1);
    expect(res.body.campaign.contacts[0].leadId).toBe(lead.id);

    // No duplicate lead was created for that phone number.
    expect(await prisma.lead.count({ where: { phoneNumber: "+15551110001" } })).toBe(1);
  });

  it("mixes selected leads (by id) and typed numbers in one campaign", async () => {
    const lead = await prisma.lead.create({ data: { phoneNumber: "+15551110002" } });

    const res = await request(app)
      .post("/api/campaigns")
      .send({
        name: "mixed campaign",
        script: "Ask about renewal",
        contacts: [{ leadId: lead.id }, { phoneNumber: "+15551110003", name: "Typed" }],
      });

    expect(res.status).toBe(201);
    expect(res.body.campaign.contacts).toHaveLength(2);
    // The typed number was upserted into a new lead and linked.
    expect(await prisma.lead.count()).toBe(2);
  });
});
