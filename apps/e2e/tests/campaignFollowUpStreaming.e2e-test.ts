// Campaign/follow-up streaming opt-in e2e test: proves that automated
// dialing (campaign contacts and follow-up callbacks, driven by the real
// in-process BullMQ Worker) actually requests Telnyx's bidirectional media
// streaming when the campaign/follow-up opted in - closing the gap where
// `processCampaignContactJob`/`processFollowUpJob` used to always dial via
// the legacy webhook path regardless of the global MEDIA_STREAM_ENABLED
// flag. Only `telnyx` is mocked (placing a real call costs money); Prisma,
// BullMQ, and every domain service (campaignService, followUpService,
// outboundDialService) run unmocked.
//
// @telephony/config is overridden (spreading the real parsed env) to turn
// MEDIA_STREAM_ENABLED on - the shared setupEnv.ts forces it off for the rest
// of the e2e suite (which drives the legacy webhook path), so this file
// needs its own override. jest.mock is file-scoped, so this only applies
// within this file's module registry.

jest.mock("@telephony/config", () => {
  const actual = jest.requireActual("@telephony/config");
  return { env: { ...actual.env, MEDIA_STREAM_ENABLED: true } };
});

interface CapturedTelnyxCreateCall {
  stream_url?: string;
  stream_track?: string;
  stream_bidirectional_mode?: string;
  stream_bidirectional_codec?: string;
}

let telnyxCreateCalls: CapturedTelnyxCreateCall[] = [];

jest.mock("telnyx", () => {
  const calls = {
    create: jest.fn(async (opts: CapturedTelnyxCreateCall) => {
      telnyxCreateCalls.push(opts);
      return { data: { call_control_id: `test-call-control-${telnyxCreateCalls.length}` } };
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
import { prisma, CampaignContactStatus, ConsentStatus } from "@telephony/database";
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
  // Obliterate (not just close) - the "dial" queue/rate-limiter state lives in
  // Redis, shared by every *.e2e-test.ts file within one --runInBand run, so
  // leftover jobs from this file could otherwise bleed into the next file's
  // tests.
  await dialQueue.obliterate({ force: true });
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telnyxCreateCalls = [];
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

describe("campaign/follow-up streaming opt-in e2e (real Postgres + Redis + worker, mocked Telnyx)", () => {
  it("dials a campaign contact with a real stream_url when the campaign opted into streaming", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15558880001" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

    const createRes = await request(app)
      .post("/api/campaigns")
      .send({ name: "streaming e2e campaign", streamingEnabled: true, contacts: [{ leadId }] });
    expect(createRes.status).toBe(201);
    const campaignId = createRes.body.campaign.id;

    await request(app).post(`/api/campaigns/${campaignId}/start`);

    await waitFor(async () => {
      const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });
      return contacts.length === 1 && contacts[0].status !== CampaignContactStatus.PENDING && contacts[0].callId !== null;
    });

    expect(telnyxCreateCalls).toHaveLength(1);
    expect(telnyxCreateCalls[0].stream_url).toEqual(expect.stringContaining("/media-stream"));
    expect(telnyxCreateCalls[0].stream_track).toBe("both_tracks");
    expect(telnyxCreateCalls[0].stream_bidirectional_codec).toBe("L16");

    const contact = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId } });
    const call = await prisma.call.findUniqueOrThrow({ where: { id: contact.callId! } });
    expect(call.streamingEnabled).toBe(true);
  });

  it("dials a campaign contact with no stream_url when the campaign opted out of streaming", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15558880002" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

    const createRes = await request(app)
      .post("/api/campaigns")
      .send({ name: "non-streaming e2e campaign", streamingEnabled: false, contacts: [{ leadId }] });
    const campaignId = createRes.body.campaign.id;

    await request(app).post(`/api/campaigns/${campaignId}/start`);

    await waitFor(async () => {
      const contacts = await prisma.campaignContact.findMany({ where: { campaignId } });
      return contacts.length === 1 && contacts[0].callId !== null;
    });

    expect(telnyxCreateCalls).toHaveLength(1);
    expect(telnyxCreateCalls[0].stream_url).toBeUndefined();

    const contact = await prisma.campaignContact.findFirstOrThrow({ where: { campaignId } });
    const call = await prisma.call.findUniqueOrThrow({ where: { id: contact.callId! } });
    expect(call.streamingEnabled).toBe(false);
  });

  it("dials a follow-up with a real stream_url when the follow-up opted into streaming", async () => {
    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15558880003" });
    const leadId = leadRes.body.lead.id;
    await prisma.lead.update({ where: { id: leadId }, data: { consentStatus: ConsentStatus.GRANTED } });

    const scheduledAt = new Date(Date.now() + 300).toISOString();
    const followUpRes = await request(app)
      .post("/api/followups")
      .send({ leadId, scheduledAt, streamingEnabled: true });
    const followUpId = followUpRes.body.followUp.id;

    await waitFor(async () => {
      const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
      return followUp.callId !== null;
    });

    expect(telnyxCreateCalls).toHaveLength(1);
    expect(telnyxCreateCalls[0].stream_url).toEqual(expect.stringContaining("/media-stream"));

    const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId } });
    const call = await prisma.call.findUniqueOrThrow({ where: { id: followUp.callId! } });
    expect(call.streamingEnabled).toBe(true);
  });
});
