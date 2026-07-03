// Inbound-call e2e test: boots the real Express app (`createApp()`) against
// real Postgres (docker-compose.yml, `npm run e2e:up`) and drives
// POST /api/calls/webhook directly with the same event shapes Telnyx itself
// posts for an inbound call. Only the `telnyx` SDK is mocked (answering/
// speaking/transcribing a real call costs money and needs a live number) -
// Prisma, Express routing, and the lead-auto-linking logic in
// callController.handleTelnyxWebhook all run for real. No TELNYX_PUBLIC_KEY
// is set in the e2e env (see setupEnv.ts), so webhook signature verification
// is in its "skip" mode, same as local dev - tests post unsigned payloads.
//
// This is the only place in the repo that exercises the inbound
// call.initiated -> call.answered -> call.hangup lifecycle end to end.

let telnyxAnswerCalls: string[] = [];
let telnyxSpeakCalls: { callControlId: string; text: string }[] = [];
let telnyxTranscriptionStartCalls: string[] = [];

jest.mock("telnyx", () => {
  return jest.fn().mockImplementation(() => ({
    calls: {
      create: jest.fn(async () => ({ data: { call_control_id: "unused-outbound-id" } })),
      answer: jest.fn(async (callControlId: string) => {
        telnyxAnswerCalls.push(callControlId);
        return {};
      }),
      speak: jest.fn(async (callControlId: string, opts: { payload: string }) => {
        telnyxSpeakCalls.push({ callControlId, text: opts.payload });
        return {};
      }),
      transcriptionStart: jest.fn(async (callControlId: string) => {
        telnyxTranscriptionStartCalls.push(callControlId);
        return {};
      }),
      hangup: jest.fn(async () => ({})),
    },
  }));
});

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, CallStatus, CallDirection } from "@telephony/database";
import { dialQueue } from "@telephony/queue";

const app = createApp();

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}

function telnyxWebhook(eventType: string, payload: Record<string, unknown>) {
  return request(app)
    .post("/api/calls/webhook")
    .send({ data: { event_type: eventType, payload } });
}

async function findCall(callControlId: string) {
  return prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
}

afterAll(async () => {
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telnyxAnswerCalls = [];
  telnyxSpeakCalls = [];
  telnyxTranscriptionStartCalls = [];
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

describe("inbound call lifecycle e2e (real Postgres, mocked Telnyx)", () => {
  it("creates an inbound Call, auto-links a new Lead by caller number, and answers the call", async () => {
    const res = await telnyxWebhook("call.initiated", {
      call_control_id: "cc-inbound-1",
      from: "+15557778888",
      to: "+15550000000",
    });
    expect(res.status).toBe(200);

    await waitFor(async () => (await findCall("cc-inbound-1")) !== null);

    const call = await findCall("cc-inbound-1");
    expect(call?.direction).toBe(CallDirection.INBOUND);
    expect(call?.status).toBe(CallStatus.RINGING);
    expect(call?.fromNumber).toBe("+15557778888");
    expect(call?.toNumber).toBe("+15550000000");
    expect(call?.leadId).not.toBeNull();

    const lead = await prisma.lead.findUniqueOrThrow({ where: { phoneNumber: "+15557778888" } });
    expect(call?.leadId).toBe(lead.id);

    expect(telnyxAnswerCalls).toEqual(["cc-inbound-1"]);
  });

  it("reuses the existing Lead for a repeat caller instead of creating a duplicate", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15556665555", firstName: "Repeat" });
    const existingLeadId = leadRes.body.lead.id;

    await telnyxWebhook("call.initiated", {
      call_control_id: "cc-inbound-2",
      from: "+15556665555",
      to: "+15550000000",
    });

    await waitFor(async () => (await findCall("cc-inbound-2")) !== null);

    const call = await findCall("cc-inbound-2");
    expect(call?.leadId).toBe(existingLeadId);

    const leads = await prisma.lead.findMany({ where: { phoneNumber: "+15556665555" } });
    expect(leads).toHaveLength(1);
  });

  it("starts transcription and speaks a greeting once the call is answered", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-inbound-3", from: "+15551112222", to: "+15550000000" });
    await waitFor(async () => (await findCall("cc-inbound-3")) !== null);

    await telnyxWebhook("call.answered", { call_control_id: "cc-inbound-3" });

    await waitFor(async () => (await findCall("cc-inbound-3"))?.status === CallStatus.IN_PROGRESS);

    const call = await findCall("cc-inbound-3");
    expect(call?.startedAt).not.toBeNull();
    expect(telnyxTranscriptionStartCalls).toEqual(["cc-inbound-3"]);
    expect(telnyxSpeakCalls).toEqual([
      { callControlId: "cc-inbound-3", text: "Hi, thanks for calling! How can I help you today?" },
    ]);
  });

  it("marks the call COMPLETED on hangup after it was answered, recording the hangup cause", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-inbound-4", from: "+15553334444", to: "+15550000000" });
    await waitFor(async () => (await findCall("cc-inbound-4")) !== null);

    await telnyxWebhook("call.answered", { call_control_id: "cc-inbound-4" });
    await waitFor(async () => (await findCall("cc-inbound-4"))?.status === CallStatus.IN_PROGRESS);

    await telnyxWebhook("call.hangup", { call_control_id: "cc-inbound-4", hangup_cause: "normal_clearing" });
    await waitFor(async () => (await findCall("cc-inbound-4"))?.status === CallStatus.COMPLETED);

    const call = await findCall("cc-inbound-4");
    expect(call?.endedAt).not.toBeNull();
    expect(call?.outcome).toBe("normal_clearing");
  });

  it("marks the call NO_ANSWER on hangup before it was ever answered", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-inbound-5", from: "+15559990000", to: "+15550000000" });
    await waitFor(async () => (await findCall("cc-inbound-5")) !== null);

    await telnyxWebhook("call.hangup", { call_control_id: "cc-inbound-5", hangup_cause: "no_answer" });
    await waitFor(async () => (await findCall("cc-inbound-5"))?.status === CallStatus.NO_ANSWER);

    // Never answered, so the greeting/transcription path must never have fired.
    expect(telnyxSpeakCalls).toEqual([]);
    expect(telnyxTranscriptionStartCalls).toEqual([]);
  });
});
