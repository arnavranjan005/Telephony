// Real call-lifecycle e2e test: boots the actual Express app and a real
// in-process BullMQ Worker against the Dockerized Postgres + Redis
// (docker-compose.yml, `npm run e2e:up` at the repo root). Only the Telnyx
// SDK is mocked - Prisma, BullMQ, and every domain service run for real, so
// this is the only place in the repo that proves the distributed
// PENDING -> CALLING claim logic actually holds under real Postgres row
// locking, not just against a mocked Prisma client.

let telnyxCallCreateCalls = 0;

jest.mock("telnyx", () => {
  const calls = {
    create: jest.fn(async () => {
      telnyxCallCreateCalls += 1;
      return { data: { call_control_id: `test-call-control-${telnyxCallCreateCalls}` } };
    }),
    answer: jest.fn(async () => ({})),
    speak: jest.fn(async () => ({})),
    transcriptionStart: jest.fn(async () => ({})),
    hangup: jest.fn(async () => ({})),
  };
  return jest.fn().mockImplementation(() => ({ calls }));
});

import request from "supertest";
import { Worker } from "bullmq";
import { createApp } from "../../api/src/app";
import { startWorker } from "../../worker/src/worker";
import { prisma, CampaignStatus, CampaignContactStatus, FollowUpStatus, CallStatus } from "@telephony/database";
import { dialQueue } from "@telephony/queue";

const app = createApp();
let worker: Worker;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

beforeAll(async () => {
  worker = startWorker();
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telnyxCallCreateCalls = 0;
  // Clean slate per test - order matters for FK constraints.
  await prisma.followUp.deleteMany();
  await prisma.campaignContact.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.call.deleteMany();
  await prisma.dncEntry.deleteMany();
  await prisma.lead.deleteMany();
});

describe("call lifecycle e2e (real Postgres + Redis)", () => {
  it("creates a lead via the real API against the real database", async () => {
    const res = await request(app).post("/api/leads").send({ phoneNumber: "+15551234567", firstName: "Ada" });

    expect(res.status).toBe(201);
    expect(res.body.lead.phoneNumber).toBe("+15551234567");

    const inDb = await prisma.lead.findUnique({ where: { id: res.body.lead.id } });
    expect(inDb).not.toBeNull();
  });

  it("dispatches a follow-up through the real queue and worker, dialing via the mocked Telnyx client", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15551110001" });
    const leadId = leadRes.body.lead.id;

    const followUpRes = await request(app)
      .post("/api/followups")
      .send({ leadId, scheduledAt: new Date().toISOString(), reason: "test" });
    expect(followUpRes.status).toBe(201);
    const followUpId = followUpRes.body.followUp.id;

    // A successful dial leaves the follow-up in CALLING with callId set
    // (status only moves to a terminal state once the call.hangup webhook
    // fires, which is out of scope here) - so wait on callId instead.
    await waitFor(async () => {
      const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
      return followUp.callId !== null;
    });

    const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
    expect(followUp.status).toBe(FollowUpStatus.CALLING);
    expect(followUp.callId).not.toBeNull();
    expect(telnyxCallCreateCalls).toBe(1);

    const call = await prisma.call.findUniqueOrThrow({ where: { id: followUp.callId! } });
    expect(call.status).toBe(CallStatus.INITIATED);
    expect(call.telnyxCallControlId).toBe("test-call-control-1");
  });

  it("skips dialing a follow-up for a lead on the DNC list", async () => {
    const phoneNumber = "+15559998888";
    await request(app).post("/api/leads").send({ phoneNumber });
    await request(app).post("/api/dnc").send({ phoneNumber, reason: "opted out" });

    const leads = await prisma.lead.findMany({ where: { phoneNumber } });
    const leadId = leads[0].id;

    const followUpRes = await request(app)
      .post("/api/followups")
      .send({ leadId, scheduledAt: new Date().toISOString() });
    const followUpId = followUpRes.body.followUp.id;

    await waitFor(async () => {
      const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
      return followUp.status !== FollowUpStatus.PENDING && followUp.status !== FollowUpStatus.CALLING;
    });

    const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
    expect(followUp.status).toBe(FollowUpStatus.SKIPPED_DNC);
    expect(telnyxCallCreateCalls).toBe(0);
  });

  it("runs a campaign end to end: create, start, dispatch every contact, and auto-complete", async () => {
    const createRes = await request(app)
      .post("/api/campaigns")
      .send({
        name: "e2e campaign",
        contacts: [{ phoneNumber: "+15552220001" }, { phoneNumber: "+15552220002" }, { phoneNumber: "+15552220003" }],
      });
    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.id;
    expect(createRes.body.campaign.contacts).toHaveLength(3);

    const startRes = await request(app).post(`/api/campaigns/${campaignId}/start`);
    expect(startRes.status).toBe(200);
    expect(startRes.body.campaign.status).toBe(CampaignStatus.RUNNING);

    // Every contact should get claimed (off PENDING) and dialed (callId set)
    // - a successful dial leaves status at CALLING with callId set, it only
    // moves to a terminal state via the call.hangup webhook (out of scope
    // here), so wait on callId rather than a terminal status.
    await waitFor(async () => {
      const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });
      return contacts.length === 3 && contacts.every((c) => c.callId !== null);
    }, 15000);

    const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });
    expect(contacts.every((c) => c.status !== CampaignContactStatus.PENDING)).toBe(true);
    expect(telnyxCallCreateCalls).toBe(3);

    await waitFor(async () => {
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      return campaign.status === CampaignStatus.COMPLETED;
    });
  });

  it("proves the distributed claim guard: concurrent processing of the same follow-up only dials once", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15553330001" });
    const leadId = leadRes.body.lead.id;

    const followUp = await prisma.followUp.create({
      data: { leadId, scheduledAt: new Date(), status: FollowUpStatus.PENDING },
    });

    const { processFollowUpJob } = await import("@telephony/domain");

    // Fire multiple concurrent "workers" racing on the exact same row against
    // the real Postgres instance - only the atomic updateMany CAS should let
    // one of them through.
    await Promise.all([
      processFollowUpJob(followUp.id),
      processFollowUpJob(followUp.id),
      processFollowUpJob(followUp.id),
      processFollowUpJob(followUp.id),
      processFollowUpJob(followUp.id),
    ]);

    expect(telnyxCallCreateCalls).toBe(1);

    const final = await prisma.followUp.findUniqueOrThrow({ where: { id: followUp.id } });
    expect(final.callId).not.toBeNull();
  });
});
