// Live call-events SSE e2e test: boots the real Express app on a real TCP
// socket (supertest can't drive a streaming response - it waits for the
// response to end, which an SSE stream never does) and drives the real
// inbound-call webhook lifecycle against real Postgres, asserting that
// call.answered/call.hangup events published by callController.handleTelnyxWebhook
// arrive over a real GET /api/calls/:callId/events connection in real time.
// Only `telnyx` is mocked (answering/speaking on a real call costs money).

let telnyxSpeakCalls: { callControlId: string; text: string }[] = [];

jest.mock("telnyx", () => {
  return jest.fn().mockImplementation(() => ({
    calls: {
      create: jest.fn(async () => ({ data: { call_control_id: "unused-outbound-id" } })),
      answer: jest.fn(async () => ({})),
      speak: jest.fn(async (callControlId: string, opts: { payload: string }) => {
        telnyxSpeakCalls.push({ callControlId, text: opts.payload });
        return {};
      }),
      transcriptionStart: jest.fn(async () => ({})),
      hangup: jest.fn(async () => ({})),
    },
  }));
});

import http from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, CallStatus } from "@telephony/database";
import { dialQueue } from "@telephony/queue";

const app = createApp();
let server: http.Server;
let baseUrl: string;

type ParsedSseEvent = { type: string; callId: string; data: unknown; timestamp: string };

function openSseConnection(callId: string): { events: ParsedSseEvent[]; close: () => void } {
  const events: ParsedSseEvent[] = [];
  let buffer = "";

  const req = http.get(`${baseUrl}/api/calls/${callId}/events`, { agent: false }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = raw.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event: "));
        const dataLine = lines.find((line) => line.startsWith("data: "));
        // The initial "connected" preamble's data payload is just
        // {callId} - it has no "type" field of its own (unlike published
        // CallEvents, which embed "type" redundantly) - so "type" has to
        // come from the SSE "event:" line, not assumed to be in the JSON body.
        if (eventLine && dataLine) {
          const type = eventLine.slice("event: ".length);
          events.push({ type, ...JSON.parse(dataLine.slice("data: ".length)) });
        }
      }
    });
  });

  return { events, close: () => req.destroy() };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 100): Promise<void> {
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

async function findCallByControlId(callControlId: string) {
  return prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
}

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // agent:false on every client request means no keep-alive socket should
  // outlive its test, but force-close defensively so a stray connection
  // can't hang server.close() (and therefore the whole Jest process).
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
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
  telnyxSpeakCalls = [];
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

describe("live call-events SSE e2e (real Postgres + real socket, mocked Telnyx)", () => {
  it("streams call.answered and call.hangup events in real time to a connected SSE client", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-sse-1", from: "+15558887777", to: "+15550000000" });
    await waitFor(async () => (await findCallByControlId("cc-sse-1")) !== null);
    const call = await findCallByControlId("cc-sse-1");

    const conn = openSseConnection(call!.id);
    await waitFor(() => conn.events.some((e) => e.type === "connected"));

    await telnyxWebhook("call.answered", { call_control_id: "cc-sse-1" });
    await waitFor(() => conn.events.some((e) => e.type === "call.answered"));

    await telnyxWebhook("call.hangup", { call_control_id: "cc-sse-1", hangup_cause: "normal_clearing" });
    await waitFor(() => conn.events.some((e) => e.type === "call.hangup"));

    const answeredEvent = conn.events.find((e) => e.type === "call.answered")!;
    expect(answeredEvent.callId).toBe(call!.id);
    expect(answeredEvent.data).toEqual({ callControlId: "cc-sse-1" });

    const hangupEvent = conn.events.find((e) => e.type === "call.hangup")!;
    expect(hangupEvent.data).toEqual({ hangupCause: "normal_clearing", status: CallStatus.COMPLETED });

    conn.close();
  });

  it("only delivers events for the subscribed callId, not events from a different call", async () => {
    await telnyxWebhook("call.initiated", { call_control_id: "cc-sse-2a", from: "+15551110000", to: "+15550000000" });
    await telnyxWebhook("call.initiated", { call_control_id: "cc-sse-2b", from: "+15552220000", to: "+15550000000" });
    await waitFor(async () => (await findCallByControlId("cc-sse-2a")) !== null && (await findCallByControlId("cc-sse-2b")) !== null);

    const callA = await findCallByControlId("cc-sse-2a");
    const conn = openSseConnection(callA!.id);
    await waitFor(() => conn.events.some((e) => e.type === "connected"));

    // Answer the *other* call, not the one this connection is subscribed to.
    await telnyxWebhook("call.answered", { call_control_id: "cc-sse-2b" });
    await waitFor(() => telnyxSpeakCalls.length >= 1);

    // Give the wrong-call event a moment to arrive if it were mistakenly broadcast.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(conn.events.some((e) => e.type === "call.answered")).toBe(false);

    conn.close();
  });
});
