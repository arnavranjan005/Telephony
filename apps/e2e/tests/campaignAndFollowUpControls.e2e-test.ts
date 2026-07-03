// Campaign/follow-up control-flow e2e test: boots the real Express app and a
// real in-process BullMQ Worker (startWorker()) against real Postgres +
// Redis, and drives the real dial rate limiter (DIAL_RATE_LIMIT_MAX /
// DIAL_RATE_LIMIT_DURATION_MS, from setupEnv.ts: 5 dials per 1000ms) and the
// campaign/follow-up cancel/pause controls. Only `telnyx` is mocked (placing
// a real call costs money) - Prisma, BullMQ, and every domain service run
// unmocked.

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
import { prisma, CampaignContactStatus, CampaignStatus, FollowUpStatus } from "@telephony/database";
import { dialQueue } from "@telephony/queue";

const app = createApp();
let worker: Worker;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 100): Promise<void> {
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

describe("campaign/follow-up controls e2e (real Postgres + Redis + worker, mocked Telnyx)", () => {
  it("cancels a PENDING follow-up before its delayed job fires, so the worker never dials it", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15556660001" });
    const leadId = leadRes.body.lead.id;

    const scheduledAt = new Date(Date.now() + 500).toISOString();
    const followUpRes = await request(app).post("/api/followups").send({ leadId, scheduledAt });
    const followUpId = followUpRes.body.followUp.id;

    const cancelRes = await request(app).post(`/api/followups/${followUpId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.followUp.status).toBe(FollowUpStatus.CANCELED);

    // The BullMQ job is still enqueued with its original delay (canceling
    // doesn't remove it) - wait past that delay so the worker actually picks
    // it up, then prove processFollowUpJob's atomic PENDING-only claim
    // turned it into a no-op instead of dialing a canceled follow-up.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(telnyxCallCreateCalls).toBe(0);
    const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
    expect(followUp.status).toBe(FollowUpStatus.CANCELED);
    expect(followUp.callId).toBeNull();
  });

  it("dials campaign contacts rate-limited (DIAL_RATE_LIMIT_MAX per DIAL_RATE_LIMIT_DURATION_MS) rather than all at once", async () => {
    const contacts = Array.from({ length: 12 }, (_, i) => ({ phoneNumber: `+1555777${String(i).padStart(4, "0")}` }));
    const createRes = await request(app).post("/api/campaigns").send({ name: "rate-limit e2e campaign", contacts });
    const campaignId = createRes.body.campaign.id;

    await request(app).post(`/api/campaigns/${campaignId}/start`);

    // Snapshot shortly after start: with a 5-per-1000ms limiter and 12 jobs
    // enqueued instantly, not all 12 should have dialed yet.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(telnyxCallCreateCalls).toBeLessThan(12);

    await waitFor(async () => {
      const remaining = await prisma.campaignContact.count({
        where: { campaignId, status: CampaignContactStatus.PENDING },
      });
      return remaining === 0;
    }, 15000);

    expect(telnyxCallCreateCalls).toBe(12);
  });

  it("flips a campaign's status to PAUSED, though contacts already enqueued by start keep dialing (pause doesn't cancel in-flight jobs)", async () => {
    const contacts = Array.from({ length: 3 }, (_, i) => ({ phoneNumber: `+1555888${String(i).padStart(4, "0")}` }));
    const createRes = await request(app).post("/api/campaigns").send({ name: "pause e2e campaign", contacts });
    const campaignId = createRes.body.campaign.id;

    await request(app).post(`/api/campaigns/${campaignId}/start`);
    const pauseRes = await request(app).post(`/api/campaigns/${campaignId}/pause`);

    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.campaign.status).toBe(CampaignStatus.PAUSED);

    // Document current, real behavior: pausing only flips the Campaign row's
    // status - it does not touch the BullMQ queue or check campaign status
    // in processCampaignContactJob, so the 3 contacts enqueued by start()
    // still get dialed by the worker even though the campaign is PAUSED.
    await waitFor(async () => {
      const contactRows = await prisma.campaignContact.findMany({ where: { campaignId } });
      return contactRows.every((c) => c.status !== CampaignContactStatus.PENDING);
    });

    expect(telnyxCallCreateCalls).toBe(3);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.PAUSED);
  });

  it("resumes a paused campaign by starting it again, re-enqueuing any contacts still PENDING", async () => {
    const contacts = [{ phoneNumber: "+15559990001" }, { phoneNumber: "+15559990002" }];
    const createRes = await request(app).post("/api/campaigns").send({ name: "resume e2e campaign", contacts });
    const campaignId = createRes.body.campaign.id;
    const contactIds: string[] = createRes.body.campaign.contacts.map((c: { id: string }) => c.id);

    await request(app).post(`/api/campaigns/${campaignId}/pause`);
    // Paused before ever starting: contacts are still PENDING and were never enqueued.
    expect(telnyxCallCreateCalls).toBe(0);

    const startRes = await request(app).post(`/api/campaigns/${campaignId}/start`);
    expect(startRes.body.campaign.status).toBe(CampaignStatus.RUNNING);

    await waitFor(async () => {
      const rows = await prisma.campaignContact.findMany({ where: { id: { in: contactIds } } });
      return rows.every((c) => c.callId !== null);
    });

    expect(telnyxCallCreateCalls).toBe(2);
  });
});
