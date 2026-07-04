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
import { prisma, CampaignStatus, CampaignContactStatus, FollowUpStatus, CallStatus, ConsentStatus } from "@telephony/database";
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
  // Obliterate (not just close) - the "dial" queue/rate-limiter state lives in
  // Redis, shared by every *.e2e-test.ts file within one --runInBand run, so
  // leftover jobs from this file could otherwise bleed into the next file's
  // tests (competing for rate-limiter throughput, or racing a later
  // beforeEach's cleanup of the Postgres rows they still reference).
  await dialQueue.obliterate({ force: true });
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telnyxCallCreateCalls = 0;
  // Clean slate per test - order matters for FK constraints. This cleans
  // every table any *.e2e-test.ts file writes to (not just the ones this
  // file uses), because all e2e files share one database within a single
  // `--runInBand` run - a row left behind by another file's last test would
  // otherwise violate a FK constraint here.
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

describe("call lifecycle e2e (real Postgres + Redis)", () => {
  it("creates a lead via the real API against the real database", async () => {
    const res = await request(app).post("/api/leads").send({ phoneNumber: "+15551234567", firstName: "Ada" });

    expect(res.status).toBe(201);
    expect(res.body.lead.phoneNumber).toBe("+15551234567");

    const inDb = await prisma.lead.findUnique({ where: { id: res.body.lead.id } });
    expect(inDb).not.toBeNull();
  });

  it("dispatches a follow-up through the real queue and worker, dialing via the mocked Telnyx client, and finalizes it COMPLETED once the call ends", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15551110001" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

    const followUpRes = await request(app)
      .post("/api/followups")
      .send({ leadId, scheduledAt: new Date().toISOString(), reason: "test" });
    expect(followUpRes.status).toBe(201);
    const followUpId = followUpRes.body.followUp.id;

    // A successful dial leaves the follow-up in CALLING with callId set -
    // status only moves to a terminal state once the call.hangup webhook
    // fires (via finalizeDialOutcome) - so wait on callId first.
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

    // Drive the call through answered -> hangup, same as a real Telnyx
    // conversation, and prove the follow-up actually reaches a terminal
    // status instead of staying CALLING forever.
    await request(app).post("/api/calls/webhook").send({
      data: { event_type: "call.answered", payload: { call_control_id: "test-call-control-1" } },
    });
    await waitFor(async () => (await prisma.call.findUniqueOrThrow({ where: { id: call.id } })).status === CallStatus.IN_PROGRESS);

    await request(app).post("/api/calls/webhook").send({
      data: {
        event_type: "call.hangup",
        payload: { call_control_id: "test-call-control-1", hangup_cause: "normal_clearing" },
      },
    });
    await waitFor(async () => (await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } })).status === FollowUpStatus.COMPLETED);
  });

  it("marks a follow-up FAILED when its dialed call is never answered", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15551110002" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

    const followUpRes = await request(app)
      .post("/api/followups")
      .send({ leadId, scheduledAt: new Date().toISOString() });
    const followUpId = followUpRes.body.followUp.id;

    await waitFor(async () => (await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } })).callId !== null);
    const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
    const callControlId = (await prisma.call.findUniqueOrThrow({ where: { id: followUp.callId! } })).telnyxCallControlId;

    // No call.answered this time - the call rings out unanswered.
    await request(app).post("/api/calls/webhook").send({
      data: { event_type: "call.hangup", payload: { call_control_id: callControlId, hangup_cause: "no_answer" } },
    });

    await waitFor(async () => (await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } })).status === FollowUpStatus.FAILED);
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

    const leadIds = createRes.body.campaign.contacts.map((c: { leadId: string }) => c.leadId);
    await prisma.lead.updateMany({ where: { id: { in: leadIds } }, data: { consentStatus: ConsentStatus.GRANTED } });

    const startRes = await request(app).post(`/api/campaigns/${campaignId}/start`);
    expect(startRes.status).toBe(200);
    expect(startRes.body.campaign.status).toBe(CampaignStatus.RUNNING);

    // Every contact should get claimed (off PENDING) and dialed (callId set)
    // - a successful dial leaves status at CALLING with callId set; it only
    // moves to CALLED once its call.hangup webhook fires (via
    // finalizeDialOutcome), so wait on callId first.
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

    // Answer and hang up every contact's call, and prove each contact
    // actually reaches CALLED instead of staying CALLING forever.
    for (const contact of contacts) {
      const contactCall = await prisma.call.findUniqueOrThrow({ where: { id: contact.callId! } });
      await request(app).post("/api/calls/webhook").send({
        data: { event_type: "call.answered", payload: { call_control_id: contactCall.telnyxCallControlId } },
      });
      await request(app).post("/api/calls/webhook").send({
        data: {
          event_type: "call.hangup",
          payload: { call_control_id: contactCall.telnyxCallControlId, hangup_cause: "normal_clearing" },
        },
      });
    }

    await waitFor(async () => {
      const finalContacts = await prisma.campaignContact.findMany({ where: { campaignId } });
      return finalContacts.every((c) => c.status === CampaignContactStatus.CALLED);
    }, 20000);
  }, 25000);

  it("proves the distributed claim guard: concurrent processing of the same follow-up only dials once", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15553330001" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

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
