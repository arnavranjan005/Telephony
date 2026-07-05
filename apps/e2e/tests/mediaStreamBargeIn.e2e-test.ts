// Media-stream barge-in e2e test: boots the real Express app on a real TCP
// socket with the real media-stream WebSocket server attached
// (attachMediaStreamServer, exactly as apps/api/src/server.ts wires it up in
// production), against real Postgres + Redis. A real `ws` client in this test
// plays the role Telnyx plays in production: it opens the WebSocket
// connection, sends "start"/"media" frames, and asserts on the "media"/
// "clear" frames sent back - proving the actual wiring (WS upgrade + token
// auth + CallStreamSession + real Prisma persistence) works end-to-end, not
// just the isolated class logic already covered by unit tests.
//
// Four things are mocked at their SDK boundary, same philosophy as the rest
// of this suite - everything else (Express routing, the real WS server,
// CallStreamSession's state machine, Prisma, the tool-calling loop, the real
// add_to_dnc tool handler) runs unmocked:
//
//   - `telnyx`               - answering/dialing a real call costs money;
//     also the only way to learn the `stream_url` (with its real, valid
//     single-use token from the *real* streamAuth module) this test's own ws
//     client needs to connect with.
//   - `@deepgram/sdk`        - no live Deepgram account in CI; mocked to let
//     this test drive "transcript"/"utteranceEnd" events on cue instead of
//     needing to send real audio.
//   - GoogleAgent            - same provider-agnostic-seam mocking as
//     aiConversation.e2e-test.ts, for the same reason (@google/genai's
//     ESM-only dynamic import can't be intercepted by jest.mock).
//   - `global.fetch`         - ttsSender.ts calls ElevenLabs' REST endpoint
//     directly via fetch; mocked to return a small deterministic PCM buffer
//     instead of hitting a live account.
//
// @telephony/config is also overridden (spreading the real parsed env so
// DATABASE_URL/REDIS_URL stay real) to turn MEDIA_STREAM_ENABLED on - it
// defaults to false, and turning it on globally in the shared setupEnv.ts
// would break every other e2e spec's inbound-call assertions (they expect
// the legacy webhook greeting/transcription path). jest.mock is file-scoped,
// so this override only applies within this file's module registry.

jest.mock("@telephony/config", () => {
  const actual = jest.requireActual("@telephony/config");
  return {
    env: {
      ...actual.env,
      MEDIA_STREAM_ENABLED: true,
      MEDIA_STREAM_WS_PATH: "/media-stream",
      MEDIA_STREAM_SAMPLE_RATE: 8000,
      DEEPGRAM_API_KEY: "test-deepgram-key",
      DEEPGRAM_MODEL: "nova-2-phonecall",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_VOICE_ID: "test-voice-id",
      // Never actually connected to - this test builds its own ws:// URL
      // from the real bound port instead of trusting BASE_URL, since the
      // real port is only known after server.listen(0) resolves.
      BASE_URL: "http://placeholder.invalid",
    },
  };
});

interface CapturedTelnyxCall {
  stream_url?: string;
}

let telnyxAnswerCalls: CapturedTelnyxCall[] = [];

jest.mock("telnyx", () => {
  return jest.fn().mockImplementation(() => ({
    calls: {
      create: jest.fn(async () => ({ data: { call_control_id: "unused-outbound-id" } })),
      answer: jest.fn(async (_callControlId: string, opts: CapturedTelnyxCall) => {
        telnyxAnswerCalls.push(opts);
        return {};
      }),
      speak: jest.fn(async () => ({})),
      transcriptionStart: jest.fn(async () => ({})),
      hangup: jest.fn(async () => ({})),
    },
  }));
});

const freebusyQuery = jest.fn();
const eventsInsert = jest.fn();

jest.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })),
    },
    calendar: jest.fn(() => ({
      freebusy: { query: freebusyQuery },
      events: { insert: eventsInsert, delete: jest.fn() },
    })),
  },
}));

type DeepgramSocketMock = {
  sendMedia: jest.Mock;
  close: jest.Mock;
  messageHandler?: (message: unknown) => void;
};

let lastDeepgramSocket: DeepgramSocketMock | null = null;

jest.mock("@deepgram/sdk", () => ({
  DeepgramClient: jest.fn().mockImplementation(() => ({
    listen: {
      v1: {
        connect: jest.fn(async () => {
          const socket: DeepgramSocketMock = { sendMedia: jest.fn(), close: jest.fn() };
          const onFn = jest.fn((event: string, handler: (message: unknown) => void) => {
            if (event === "message") socket.messageHandler = handler;
          });
          lastDeepgramSocket = socket;
          return { ...socket, on: onFn };
        }),
      },
    },
  })),
}));

type ScriptedReply = {
  content: string | null;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
};

let scriptedReplies: ScriptedReply[] = [];
/** If set, invoked once from inside the mocked generateReply, before it
 * resolves - lets a test simulate a barge-in landing exactly while the agent
 * is "thinking", deterministically, without racing real timers. */
let duringGeneration: (() => void) | null = null;

jest.mock("../../api/src/ai/providers/googleAgent", () => ({
  GoogleAgent: jest.fn().mockImplementation(() => ({
    providerName: "google-mock",
    generateReply: jest.fn(async () => {
      duringGeneration?.();
      const next = scriptedReplies.shift();
      if (!next) throw new Error("mediaStreamBargeIn e2e: scriptedReplies exhausted");
      return next;
    }),
  })),
}));

import http from "http";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import request from "supertest";
import { createApp } from "../../api/src/app";
import { attachMediaStreamServer } from "../../api/src/media-stream/mediaStreamServer";
import { prisma, LeadStatus } from "@telephony/database";
import { dialQueue, followUpJobId } from "@telephony/queue";
import { nextCallingWindowStart } from "@telephony/domain";

const app = createApp();
let server: http.Server;
let baseWsUrl: string;

function makePcmBuffer(frameCount: number): ArrayBuffer {
  const bytesPerFrame = 320; // 8000 Hz * 20ms * 2 bytes/sample
  const buffer = Buffer.alloc(bytesPerFrame * frameCount, 1);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 50): Promise<void> {
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

/** Connects this test's own ws client (playing Telnyx's role) using the real
 * stream_url + token captured from the mocked answer() call. */
async function openMediaStreamSocket(callControlId: string): Promise<{
  ws: WebSocket;
  frames: Record<string, unknown>[];
}> {
  const captured = telnyxAnswerCalls[telnyxAnswerCalls.length - 1];
  const streamUrl = new URL(captured.stream_url!);
  const testUrl = new URL(baseWsUrl + streamUrl.pathname + streamUrl.search);

  const frames: Record<string, unknown>[] = [];
  const socket = new WebSocket(testUrl.toString());
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(
    JSON.stringify({
      event: "start",
      sequence_number: "1",
      start: { call_control_id: callControlId, stream_id: "stream_1", media_format: { encoding: "L16", sample_rate: 8000, channels: 1 } },
    })
  );

  return { ws: socket, frames };
}

function sendInboundAudio(socket: WebSocket) {
  socket.send(
    JSON.stringify({
      event: "media",
      sequence_number: "2",
      stream_id: "stream_1",
      media: { track: "inbound", chunk: "1", timestamp: "20", payload: Buffer.from([1, 2, 3]).toString("base64") },
    })
  );
}

function emitTranscript(transcript: string, isFinal: boolean, speechFinal: boolean) {
  lastDeepgramSocket!.messageHandler!({
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  });
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  attachMediaStreamServer(server);
  const port = (server.address() as AddressInfo).port;
  baseWsUrl = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await dialQueue.obliterate({ force: true });
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  telnyxAnswerCalls = [];
  lastDeepgramSocket = null;
  scriptedReplies = [];
  duringGeneration = null;
  freebusyQuery.mockReset();
  eventsInsert.mockReset();
  global.fetch = jest.fn(async () => ({
    ok: true,
    arrayBuffer: async () => makePcmBuffer(10),
  })) as unknown as typeof fetch;

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

describe("media-stream barge-in e2e (real Postgres + real WebSocket, mocked Telnyx/Deepgram/GoogleAgent/fetch)", () => {
  it("greets on start, drives a real tool call to a persisted DncEntry, and streams the reply as real media frames", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-stream-1", from: "+15556661111", to: "+15550000000" });
    await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: "cc-stream-1" } })) !== null);
    await telnyxWebhook("call.answered", { call_control_id: "cc-stream-1" });
    await waitFor(() => telnyxAnswerCalls.length >= 1);

    const call = await prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: "cc-stream-1" } });
    expect(call.streamingEnabled).toBe(true);

    const { ws: client, frames } = await openMediaStreamSocket("cc-stream-1");

    // The "start" frame triggers CallStreamSession's greeting.
    await waitFor(() => frames.some((f) => f.event === "media"));
    await waitFor(() => lastDeepgramSocket !== null);

    sendInboundAudio(client);
    await waitFor(() => lastDeepgramSocket!.sendMedia.mock.calls.length >= 1);

    scriptedReplies = [
      { content: null, toolCalls: [{ id: "call-1", name: "add_to_dnc", args: { reason: "asked to stop calling" } }] },
      { content: "Understood, you won't hear from us again.", toolCalls: [] },
    ];

    emitTranscript("please stop calling me", true, true);

    const dncEntry = await (async () => {
      await waitFor(async () => (await prisma.dncEntry.findUnique({ where: { phoneNumber: "+15556661111" } })) !== null, 15000);
      return prisma.dncEntry.findUniqueOrThrow({ where: { phoneNumber: "+15556661111" } });
    })();
    expect(dncEntry.reason).toBe("asked to stop calling");
    expect(dncEntry.source).toBe("CALLER_REQUEST");

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.toolName, m.interrupted])).toEqual([
      ["USER", null, false],
      ["ASSISTANT", "add_to_dnc", false],
      ["TOOL", "add_to_dnc", false],
      ["ASSISTANT", null, false],
    ]);
    expect(messages[0].content).toBe("please stop calling me");

    // The final reply was actually streamed back as real "media" frames over the wire.
    const mediaFramesAfterReply = frames.filter((f) => f.event === "media");
    expect(mediaFramesAfterReply.length).toBeGreaterThan(1); // greeting + at least one reply frame

    client.close();
  });

  it("barge-in mid-reply sends a real clear frame before any further audio, and the interruption starts a fresh turn", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-stream-2", from: "+15556662222", to: "+15550000000" });
    await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: "cc-stream-2" } })) !== null);
    await telnyxWebhook("call.answered", { call_control_id: "cc-stream-2" });
    await waitFor(() => telnyxAnswerCalls.length >= 1);
    const call = await prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: "cc-stream-2" } });

    const { ws: client, frames } = await openMediaStreamSocket("cc-stream-2");
    await waitFor(() => frames.some((f) => f.event === "media")); // greeting
    await waitFor(() => lastDeepgramSocket !== null);

    // First turn: a long reply (10 frames * 20ms = ~200ms of real "playback"),
    // long enough to reliably interrupt mid-stream.
    scriptedReplies = [{ content: "This is a fairly long reply that keeps talking for a while", toolCalls: [] }];
    const framesBeforeFirstReply = frames.length;
    emitTranscript("tell me about your hours", true, true);

    // Wait for at least one reply frame to have gone out, proving playback
    // has genuinely started, before interrupting.
    await waitFor(() => frames.length > framesBeforeFirstReply + 1);

    // Script the *next* turn's reply before triggering the barge-in, so it's
    // ready the instant the interrupting utterance's turn starts.
    scriptedReplies = [{ content: "Sure, let's do Friday instead.", toolCalls: [] }];
    const frameCountAtInterrupt = frames.length;
    emitTranscript("wait, actually", false, false); // interim - the barge-in signal

    await waitFor(() => frames.some((f, i) => i >= frameCountAtInterrupt && f.event === "clear"));
    const clearIndex = frames.findIndex((f, i) => i >= frameCountAtInterrupt && f.event === "clear");
    const framesRightAfterClear = frames.length;

    // Give any wrongly-continued pacing loop a moment to prove it didn't keep sending.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.length).toBe(framesRightAfterClear); // no more frames arrived after `clear`
    expect(clearIndex).toBeGreaterThanOrEqual(0);

    // Finish the caller's new utterance - this should drive a fresh turn.
    emitTranscript("what about Friday", true, true);
    await waitFor(() => frames.some((f, i) => i > clearIndex && f.event === "media"), 15000);

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    const userMessages = messages.filter((m) => m.role === "USER");
    expect(userMessages.map((m) => m.content)).toEqual(["tell me about your hours", "what about Friday"]);

    client.close();
  });

  it("negotiates a follow-up time outside legal calling hours to a real FollowUp row + enqueued BullMQ job, over the real stream", async () => {
    // Same real (unmocked) domain function and area-code reasoning as the
    // webhook-path equivalent in aiConversation.e2e-test.ts - proves the
    // identical negotiation behavior holds when driven through
    // CallStreamSession's tool set instead of the webhook conversation path.
    const phoneNumber = "+12125557777";
    const requestedOutOfWindow = new Date("2026-08-02T07:00:00Z");
    const suggestedTime = nextCallingWindowStart(phoneNumber, requestedOutOfWindow);

    await telnyxWebhook("call.initiated", { call_control_id: "cc-stream-3", from: phoneNumber, to: "+15550000000" });
    await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: "cc-stream-3" } })) !== null);
    await telnyxWebhook("call.answered", { call_control_id: "cc-stream-3" });
    await waitFor(() => telnyxAnswerCalls.length >= 1);
    const call = await prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: "cc-stream-3" } });

    const { ws: client, frames } = await openMediaStreamSocket("cc-stream-3");
    await waitFor(() => frames.some((f) => f.event === "media")); // greeting
    await waitFor(() => lastDeepgramSocket !== null);

    scriptedReplies = [
      {
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: "schedule_followup",
            args: { scheduledAt: requestedOutOfWindow.toISOString(), reason: "callback about pricing" },
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "call-2",
            name: "schedule_followup",
            args: { scheduledAt: suggestedTime.toISOString(), reason: "callback about pricing" },
          },
        ],
      },
      { content: "Great, I'll call you back then.", toolCalls: [] },
    ];

    emitTranscript("can you call me back tomorrow at 3am my time about pricing", true, true);

    await waitFor(async () => (await prisma.followUp.findFirst({ where: { leadId: call.leadId! } })) !== null, 15000);

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.toolName])).toEqual([
      ["USER", null],
      ["ASSISTANT", "schedule_followup"],
      ["TOOL", "schedule_followup"],
      ["ASSISTANT", "schedule_followup"],
      ["TOOL", "schedule_followup"],
      ["ASSISTANT", null],
    ]);
    expect(JSON.parse(messages[2].content)).toEqual({
      scheduled: false,
      reason: "Requested time is outside the legal calling window (8am-9pm local to this number)",
      suggestedTime: suggestedTime.toISOString(),
    });
    const confirmedResult = JSON.parse(messages[4].content);
    expect(confirmedResult.scheduled).toBe(true);

    const followUps = await prisma.followUp.findMany({ where: { leadId: call.leadId! } });
    expect(followUps).toHaveLength(1);
    expect(followUps[0].scheduledAt.toISOString()).toBe(suggestedTime.toISOString());

    const job = await dialQueue.getJob(followUpJobId(followUps[0].id));
    expect(job).not.toBeUndefined();

    // The confirmation was actually spoken back as real media frames.
    await waitFor(() => frames.filter((f) => f.event === "media").length > 1);

    client.close();
  });

  it("drives a caller utterance through update_lead_status to a real Lead row update, over the real stream", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-stream-4", from: "+15556668888", to: "+15550000000" });
    await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: "cc-stream-4" } })) !== null);
    await telnyxWebhook("call.answered", { call_control_id: "cc-stream-4" });
    await waitFor(() => telnyxAnswerCalls.length >= 1);
    const call = await prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: "cc-stream-4" } });

    const { ws: client, frames } = await openMediaStreamSocket("cc-stream-4");
    await waitFor(() => frames.some((f) => f.event === "media")); // greeting
    await waitFor(() => lastDeepgramSocket !== null);

    scriptedReplies = [
      {
        content: null,
        toolCalls: [
          { id: "call-1", name: "update_lead_status", args: { status: "HOT", notes: "Ready to buy now, budget confirmed" } },
        ],
      },
      { content: "Great, I've made a note of that. Anything else?", toolCalls: [] },
    ];

    emitTranscript("yes, I'm very interested and ready to buy right now", true, true);

    await waitFor(async () => (await prisma.lead.findUniqueOrThrow({ where: { id: call.leadId! } })).status === LeadStatus.HOT, 15000);

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.toolName])).toEqual([
      ["USER", null],
      ["ASSISTANT", "update_lead_status"],
      ["TOOL", "update_lead_status"],
      ["ASSISTANT", null],
    ]);
    expect(JSON.parse(messages[2].content)).toEqual({ updated: true, leadId: call.leadId, status: "HOT" });

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: call.leadId! } });
    expect(lead.notes).toBe("Ready to buy now, budget confirmed");

    await waitFor(() => frames.filter((f) => f.event === "media").length > 1);

    client.close();
  });

  it("drives a caller utterance through availability-check -> booking tool calls to a real Appointment row, over the real stream", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-stream-5", from: "+15556669999", to: "+15550000000" });
    await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: "cc-stream-5" } })) !== null);
    await telnyxWebhook("call.answered", { call_control_id: "cc-stream-5" });
    await waitFor(() => telnyxAnswerCalls.length >= 1);
    const call = await prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: "cc-stream-5" } });

    const { ws: client, frames } = await openMediaStreamSocket("cc-stream-5");
    await waitFor(() => frames.some((f) => f.event === "media")); // greeting
    await waitFor(() => lastDeepgramSocket !== null);

    freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
    eventsInsert.mockResolvedValue({
      data: {
        id: "evt_stream_e2e",
        htmlLink: "https://calendar.google.com/evt_stream_e2e",
        start: { dateTime: "2026-08-01T14:00:00Z" },
        end: { dateTime: "2026-08-01T14:30:00Z" },
      },
    });

    scriptedReplies = [
      {
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: "check_appointment_availability",
            args: { startTime: "2026-08-01T14:00:00Z", endTime: "2026-08-01T14:30:00Z" },
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "call-2",
            name: "schedule_appointment",
            args: {
              title: "Consultation call",
              startTime: "2026-08-01T14:00:00Z",
              endTime: "2026-08-01T14:30:00Z",
              attendeeEmail: "lead@example.com",
            },
          },
        ],
      },
      { content: "Great, you're booked for 2pm on August 1st.", toolCalls: [] },
    ];

    emitTranscript("I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com", true, true);

    await waitFor(async () => (await prisma.appointment.findFirst({ where: { callId: call.id } })) !== null, 15000);

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => [m.role, m.toolName])).toEqual([
      ["USER", null],
      ["ASSISTANT", "check_appointment_availability"],
      ["TOOL", "check_appointment_availability"],
      ["ASSISTANT", "schedule_appointment"],
      ["TOOL", "schedule_appointment"],
      ["ASSISTANT", null],
    ]);
    expect(JSON.parse(messages[2].content)).toEqual({ available: true });
    expect(JSON.parse(messages[4].content).booked).toBe(true);

    const appointment = await prisma.appointment.findFirstOrThrow({ where: { callId: call.id } });
    expect(appointment.googleEventId).toBe("evt_stream_e2e");
    expect(appointment.leadId).toBe(call.leadId);
    expect(eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ summary: "Consultation call" }) })
    );

    await waitFor(() => frames.filter((f) => f.event === "media").length > 1);

    client.close();
  });
});
