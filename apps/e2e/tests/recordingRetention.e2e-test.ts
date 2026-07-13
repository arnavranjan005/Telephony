// Real recording-retention e2e test: boots the actual Express app and the
// real in-process recording-cleanup BullMQ Worker against the Dockerized
// Postgres + Redis. Only the Telnyx SDK is mocked (there's no real recording
// to fetch/delete) - Prisma and BullMQ run for real, so this proves the
// call.recording.saved webhook actually persists the session id, schedules a
// real delayed deletion job, serves a fresh download URL, and that the
// cleanup path deletes from Telnyx and clears our references.

const recordingsDeleted: string[] = [];
let recordingsListResult: Array<{ id?: string; download_urls?: { mp3?: string | null } }> = [];

jest.mock("telnyx", () => {
  const calls = {
    create: jest.fn(async () => ({ data: { call_control_id: "rec-e2e-ctrl" } })),
    answer: jest.fn(async () => ({})),
    speak: jest.fn(async () => ({})),
    transcriptionStart: jest.fn(async () => ({})),
    hangup: jest.fn(async () => ({})),
    recordStart: jest.fn(async () => ({})),
  };
  const callRecordings = {
    list: jest.fn(async () => ({ data: recordingsListResult })),
    del: jest.fn(async (id: string) => {
      recordingsDeleted.push(id);
      return {};
    }),
  };
  return jest.fn().mockImplementation(() => ({ calls, callRecordings }));
});

import request from "supertest";
import { Worker } from "bullmq";
import { createApp } from "../../api/src/app";
import { startRecordingCleanupWorker } from "../../worker/src/worker";
import { prisma, CallDirection, CallStatus } from "@telephony/database";
import { recordingCleanupQueue, recordingDeletionJobId } from "@telephony/queue";
import { processRecordingDeletion } from "@telephony/domain";
import http from "node:http";
import type { AddressInfo } from "node:net";

const app = createApp();
let worker: Worker;

// A tiny local "recording CDN" the API's proxy fetches from (stands in for
// Telnyx's real download URL, which the mocked SDK points here).
const AUDIO_BYTES = Buffer.from("ID3-e2e-fake-mp3-audio-bytes");
let audioServer: http.Server;
let audioUrl: string;

async function flushWebhook() {
  // The webhook endpoint acks 200 before processing; give the async handler a
  // tick to land its DB write / enqueue.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

beforeAll(async () => {
  worker = startRecordingCleanupWorker();
  await worker.waitUntilReady();
  audioServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": AUDIO_BYTES.length });
    res.end(AUDIO_BYTES);
  });
  await new Promise<void>((resolve) => audioServer.listen(0, resolve));
  audioUrl = `http://127.0.0.1:${(audioServer.address() as AddressInfo).port}/rec.mp3`;
});

afterAll(async () => {
  await worker.close();
  // Obliterate (not just close) - queue state lives in Redis shared across all
  // *.e2e-test.ts files in one --runInBand run, so leftover jobs must not bleed
  // into another file's run.
  await recordingCleanupQueue.obliterate({ force: true });
  await recordingCleanupQueue.close();
  await new Promise<void>((resolve) => audioServer.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  recordingsDeleted.length = 0;
  recordingsListResult = [];
  await recordingCleanupQueue.obliterate({ force: true });
  // Shared-DB cleanup (see callLifecycle.e2e-test.ts) - order matters for FKs.
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

async function createCall() {
  return prisma.call.create({
    data: {
      telnyxCallControlId: "rec-e2e-ctrl",
      direction: CallDirection.OUTBOUND,
      status: CallStatus.IN_PROGRESS,
      fromNumber: "+15550000000",
      toNumber: "+15551234567",
    },
  });
}

describe("recording retention e2e (real Postgres + Redis)", () => {
  it("persists the session id and schedules a real delayed deletion job on call.recording.saved", async () => {
    const call = await createCall();

    await request(app)
      .post("/api/calls/webhook")
      .send({
        data: {
          event_type: "call.recording.saved",
          payload: {
            call_control_id: "rec-e2e-ctrl",
            call_session_id: "rec-e2e-session",
            recording_urls: { mp3: "https://signed.telnyx.example/expires-in-10-min.mp3" },
          },
        },
      });
    await flushWebhook();

    const updated = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(updated.telnyxCallSessionId).toBe("rec-e2e-session");
    // We store a stable in-app link, never the ~10-min signed Telnyx URL.
    expect(updated.recordingUrl).toContain(`/api/calls/${call.id}/recording`);
    expect(updated.recordingUrl).not.toContain("signed.telnyx.example");

    // A real delayed job now sits in Redis, keyed deterministically, due after
    // the retention window (default 12h).
    const job = await recordingCleanupQueue.getJob(recordingDeletionJobId(call.id));
    expect(job).not.toBeNull();
    expect(job?.data).toEqual({ callId: call.id });
    expect(job?.delay).toBe(12 * 60 * 60 * 1000);
  });

  it("streams the recording audio (proxied from Telnyx) via GET /api/calls/:id/recording", async () => {
    const call = await prisma.call.create({
      data: {
        telnyxCallControlId: "rec-e2e-ctrl",
        direction: CallDirection.OUTBOUND,
        status: CallStatus.COMPLETED,
        fromNumber: "+15550000000",
        toNumber: "+15551234567",
        telnyxCallSessionId: "rec-e2e-session",
      },
    });
    // Point Telnyx's download URL at a local audio fixture so the proxy has
    // something real to stream back.
    recordingsListResult = [{ id: "rec_1", download_urls: { mp3: audioUrl } }];

    const res = await request(app).get(`/api/calls/${call.id}/recording`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.body.length).toBe(AUDIO_BYTES.length);
  });

  it("returns 404 for a call that has no recording", async () => {
    const call = await createCall();

    const res = await request(app).get(`/api/calls/${call.id}/recording`).redirects(0);

    expect(res.status).toBe(404);
  });

  it("deletes the recording from Telnyx and clears our references when the cleanup job runs", async () => {
    const call = await prisma.call.create({
      data: {
        telnyxCallControlId: "rec-e2e-ctrl",
        direction: CallDirection.OUTBOUND,
        status: CallStatus.COMPLETED,
        fromNumber: "+15550000000",
        toNumber: "+15551234567",
        telnyxCallSessionId: "rec-e2e-session",
        recordingUrl: "http://localhost:3000/calls/x/recording",
      },
    });
    recordingsListResult = [{ id: "rec_1" }, { id: "rec_2" }];

    // Invoke the job body directly rather than waiting out the 12h delay.
    await processRecordingDeletion(call.id);

    expect(recordingsDeleted).toEqual(["rec_1", "rec_2"]);
    const cleared = await prisma.call.findUniqueOrThrow({ where: { id: call.id } });
    expect(cleared.telnyxCallSessionId).toBeNull();
    expect(cleared.recordingUrl).toBeNull();
  });
});
