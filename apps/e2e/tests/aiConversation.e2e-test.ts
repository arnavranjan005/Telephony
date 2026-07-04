// AI-conversation e2e test: boots the real Express app against real
// Postgres (docker-compose.yml, `npm run e2e:up`) and drives a live inbound
// call's transcription webhook through the real conversation pipeline -
// callConversationService.handleCallerUtterance, the real tool-calling loop
// in conversationRunner.ts, and the real calendar/compliance tool handlers
// (which do real Prisma writes and call the real calendarService/dncService
// functions). Three SDKs are mocked at their boundary:
//
//   - `telnyx`        - answering/speaking on a real call costs money.
//   - `googleapis`    - needs a live OAuth-authorized Google Calendar.
//   - GoogleAgent     - `@google/genai` is ESM-only with a broken CJS
//     "require" condition, so googleAgent.ts loads it via a Function-
//     constructor dynamic import specifically to dodge ts-jest's
//     import()->require() rewrite (see the comment in googleAgent.ts and
//     the note in googleAgent.test.ts). That same trick means a real
//     `import()` runs at test time, which Jest's CommonJS module registry
//     cannot intercept with jest.mock() without --experimental-vm-modules -
//     so instead of mocking the vendor SDK, this test mocks the
//     provider-agnostic AIAgent wrapper one layer up (the same seam the
//     app's own AI-provider-swapping design already relies on), and scripts
//     its replies to drive the tool-calling loop exactly as a real Gemini
//     response would.
//
// This is the only place in the repo that proves an inbound caller's
// utterance can flow all the way through the AI agent's tool calls to real
// Appointment/DncEntry rows and back out through a spoken Telnyx reply.

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

type ScriptedReply = {
  content: string | null;
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
};

let scriptedReplies: ScriptedReply[] = [];
let generateReplyToolNames: string[][] = [];

jest.mock("../../api/src/ai/providers/googleAgent", () => ({
  GoogleAgent: jest.fn().mockImplementation(() => ({
    providerName: "google-mock",
    generateReply: jest.fn(async (_messages: unknown[], tools: { name: string }[]) => {
      generateReplyToolNames.push(tools.map((t) => t.name));
      const next = scriptedReplies.shift();
      if (!next) throw new Error("aiConversation e2e: scriptedReplies exhausted - test scripted too few rounds");
      return next;
    }),
  })),
}));

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, CallStatus } from "@telephony/database";
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

async function setUpAnsweredInboundCall(callControlId: string, fromNumber: string) {
  await telnyxWebhook("call.initiated", { call_control_id: callControlId, from: fromNumber, to: "+15550000000" });
  await waitFor(async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } })) !== null);

  await telnyxWebhook("call.answered", { call_control_id: callControlId });
  await waitFor(
    async () => (await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } }))?.status === CallStatus.IN_PROGRESS
  );

  return prisma.call.findUniqueOrThrow({ where: { telnyxCallControlId: callControlId } });
}

afterAll(async () => {
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
  scriptedReplies = [];
  generateReplyToolNames = [];
  freebusyQuery.mockReset();
  eventsInsert.mockReset();
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

describe("AI conversation e2e (real Postgres, mocked Telnyx/Google Calendar SDKs, scripted AI agent)", () => {
  it("drives a caller utterance through availability-check -> booking tool calls to a real Appointment row and a spoken confirmation", async () => {
    const call = await setUpAnsweredInboundCall("cc-ai-book-1", "+15552223333");
    // Greeting from call.answered already spoke once.
    expect(telnyxSpeakCalls).toHaveLength(1);

    freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
    eventsInsert.mockResolvedValue({
      data: {
        id: "evt_ai_e2e",
        htmlLink: "https://calendar.google.com/evt_ai_e2e",
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
      { content: "Great, you're booked for 2pm on August 1st. Anything else?", toolCalls: [] },
    ];

    await telnyxWebhook("call.transcription", {
      call_control_id: "cc-ai-book-1",
      transcription_data: {
        transcript: "I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com",
        is_final: true,
      },
    });

    await waitFor(async () => telnyxSpeakCalls.length >= 2, 15000);

    expect(telnyxSpeakCalls[1]).toEqual({
      callControlId: "cc-ai-book-1",
      text: "Great, you're booked for 2pm on August 1st. Anything else?",
    });
    expect(generateReplyToolNames[0]).toEqual(
      expect.arrayContaining(["check_appointment_availability", "schedule_appointment", "add_to_dnc"])
    );

    const messages = await prisma.conversationMessage.findMany({
      where: { callId: call.id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages.map((m) => [m.role, m.toolName])).toEqual([
      ["USER", null],
      ["ASSISTANT", "check_appointment_availability"],
      ["TOOL", "check_appointment_availability"],
      ["ASSISTANT", "schedule_appointment"],
      ["TOOL", "schedule_appointment"],
      ["ASSISTANT", null],
    ]);
    expect(messages[0].content).toBe("I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com");
    expect(JSON.parse(messages[2].content)).toEqual({ available: true });
    expect(JSON.parse(messages[4].content).booked).toBe(true);

    const appointment = await prisma.appointment.findFirst({ where: { callId: call.id } });
    expect(appointment?.googleEventId).toBe("evt_ai_e2e");
    expect(appointment?.leadId).toBe(call.leadId);
    expect(eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ summary: "Consultation call" }) })
    );
  });

  it("drives an opt-out utterance through the add_to_dnc tool to a real DncEntry row honored immediately", async () => {
    const call = await setUpAnsweredInboundCall("cc-ai-dnc-1", "+15554445555");
    expect(telnyxSpeakCalls).toHaveLength(1);

    scriptedReplies = [
      {
        content: null,
        toolCalls: [{ id: "call-1", name: "add_to_dnc", args: { reason: "asked to stop calling" } }],
      },
      { content: "Understood, you won't hear from us again. Take care.", toolCalls: [] },
    ];

    await telnyxWebhook("call.transcription", {
      call_control_id: "cc-ai-dnc-1",
      transcription_data: { transcript: "Please stop calling me, take me off your list", is_final: true },
    });

    await waitFor(async () => telnyxSpeakCalls.length >= 2, 15000);

    expect(telnyxSpeakCalls[1].text).toBe("Understood, you won't hear from us again. Take care.");

    const dncEntry = await prisma.dncEntry.findUnique({ where: { phoneNumber: "+15554445555" } });
    expect(dncEntry).not.toBeNull();
    expect(dncEntry?.reason).toBe("asked to stop calling");
    expect(dncEntry?.source).toBe("CALLER_REQUEST");

    const messages = await prisma.conversationMessage.findMany({ where: { callId: call.id }, orderBy: { createdAt: "asc" } });
    expect(messages.map((m) => m.toolName)).toEqual([null, "add_to_dnc", "add_to_dnc", null]);
  });
});
