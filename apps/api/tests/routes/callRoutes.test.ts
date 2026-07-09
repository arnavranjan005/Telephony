const callCreate = jest.fn();
const callFindMany = jest.fn();
const callFindUnique = jest.fn();
const callUpdate = jest.fn();
const leadUpsert = jest.fn();

jest.mock("@telephony/database", () => ({
  ...jest.requireActual("@prisma/client"),
  prisma: {
    call: {
      create: (...args: unknown[]) => callCreate(...args),
      findMany: (...args: unknown[]) => callFindMany(...args),
      findUnique: (...args: unknown[]) => callFindUnique(...args),
      update: (...args: unknown[]) => callUpdate(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
    },
  },
}));

// @telephony/domain is mocked as a single unit here (its own internals - DNC
// check, Telnyx dialing, etc. - are covered by packages/domain's own test
// suite, not re-tested through the API layer).
const placeOutboundCall = jest.fn();
const answerCall = jest.fn();
const speakText = jest.fn();
const startTranscription = jest.fn();
const finalizeDialOutcome = jest.fn();

jest.mock("@telephony/domain", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
  answerCall: (...args: unknown[]) => answerCall(...args),
  speakText: (...args: unknown[]) => speakText(...args),
  startTranscription: (...args: unknown[]) => startTranscription(...args),
  finalizeDialOutcome: (...args: unknown[]) => finalizeDialOutcome(...args),
  decodeClientState: (clientState?: string) => {
    if (!clientState) return {};
    try {
      return JSON.parse(Buffer.from(clientState, "base64").toString("utf-8"));
    } catch {
      return {};
    }
  },
}));

const verifyTelnyxSignature = jest.fn();
jest.mock("../../src/telnyx/webhookVerifier", () => ({
  verifyTelnyxSignature: (...args: unknown[]) => verifyTelnyxSignature(...args),
}));

jest.mock("../../src/callConversationService", () => ({
  handleCallerUtterance: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Call routes", () => {
  it("POST /api/calls/outbound creates a Call record and initiates the Telnyx call", async () => {
    placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
    callFindUnique.mockResolvedValue({ id: "call_1", telnyxCallControlId: "ctrl_123", status: "INITIATED" });

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(201);
    expect(res.body.call.telnyxCallControlId).toBe("ctrl_123");
    // Streaming defaults to requested (true) here, but MEDIA_STREAM_ENABLED
    // defaults to false in this test env (see setupEnv.ts), so it resolves false.
    expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", undefined, { streamingEnabled: false });
  });

  it("does not enable streaming when requested but MEDIA_STREAM_ENABLED is globally off", async () => {
    placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
    callFindUnique.mockResolvedValue({ id: "call_1", telnyxCallControlId: "ctrl_123", status: "INITIATED" });

    await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567", streaming: true });

    // MEDIA_STREAM_ENABLED defaults to false in this test env (see setupEnv.ts) -
    // a per-request "streaming: true" alone can't turn on a feature that's off globally.
    expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", undefined, { streamingEnabled: false });
  });

  it("POST /api/calls/outbound rejects a request missing toNumber", async () => {
    const res = await request(app).post("/api/calls/outbound").send({});

    expect(res.status).toBe(400);
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it("POST /api/calls/outbound returns 403 and never dials when the number is on the DNC list", async () => {
    placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(403);
  });

  it("POST /api/calls/outbound returns 502 if Telnyx fails to place the call", async () => {
    placeOutboundCall.mockResolvedValue({ outcome: "failed", error: "Telnyx unavailable" });

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Telnyx unavailable");
  });

  it("GET /api/calls/:callId returns 404 when the call does not exist", async () => {
    callFindUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/calls/missing");

    expect(res.status).toBe(404);
  });

  it("POST /api/calls/webhook rejects an invalid signature without touching the database", async () => {
    verifyTelnyxSignature.mockReturnValue(false);

    const res = await request(app)
      .post("/api/calls/webhook")
      .send({ data: { event_type: "call.answered", payload: { call_control_id: "ctrl_1" } } });

    expect(res.status).toBe(401);
    expect(callUpdate).not.toHaveBeenCalled();
  });

  async function sendWebhook(eventType: string, payload: Record<string, unknown>) {
    verifyTelnyxSignature.mockReturnValue(true);
    const res = await request(app)
      .post("/api/calls/webhook")
      .send({ data: { event_type: eventType, payload } });
    // Webhook processing happens after the immediate 200 ack; flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  }

  it("POST /api/calls/webhook acknowledges a validly signed call.hangup event and updates the call", async () => {
    callFindUnique.mockResolvedValue({ id: "call_1", status: "IN_PROGRESS" });
    callUpdate.mockResolvedValue({ id: "call_1", status: "COMPLETED" });

    const res = await sendWebhook("call.hangup", { call_control_id: "ctrl_1" });

    expect(res.status).toBe(200);
    expect(callUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telnyxCallControlId: "ctrl_1" } })
    );
    expect(finalizeDialOutcome).toHaveBeenCalledWith("call_1", "COMPLETED");
  });

  describe("call.answered", () => {
    it("greets the caller and starts transcription for a non-streaming call", async () => {
      callUpdate.mockResolvedValue({ id: "call_1", streamingEnabled: false });

      await sendWebhook("call.answered", { call_control_id: "ctrl_1" });

      expect(startTranscription).toHaveBeenCalledWith("ctrl_1");
      expect(speakText).toHaveBeenCalledWith("ctrl_1", expect.any(String));
    });

    it("skips the legacy greeting/transcription for a streaming-enabled call (CallStreamSession handles it instead)", async () => {
      callUpdate.mockResolvedValue({ id: "call_1", streamingEnabled: true });

      await sendWebhook("call.answered", { call_control_id: "ctrl_1" });

      expect(startTranscription).not.toHaveBeenCalled();
      expect(speakText).not.toHaveBeenCalled();
    });
  });

  describe("call.initiated (inbound)", () => {
    it("upserts a Lead by caller phone number and links it to the new Call", async () => {
      callFindUnique.mockResolvedValue(null); // no pre-existing Call -> genuine inbound
      leadUpsert.mockResolvedValue({ id: "lead_1", phoneNumber: "+15559876543" });
      callCreate.mockResolvedValue({ id: "call_1" });

      await sendWebhook("call.initiated", { call_control_id: "ctrl_1", from: "+15559876543", to: "+15550000000" });

      expect(leadUpsert).toHaveBeenCalledWith({
        where: { phoneNumber: "+15559876543" },
        update: {},
        create: { phoneNumber: "+15559876543" },
      });
      expect(callCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ leadId: "lead_1" }) })
      );
      expect(answerCall).toHaveBeenCalledWith("ctrl_1", undefined, true); // record: true - see callController.ts
    });

    it("skips lead linking when the caller's number is missing from the payload", async () => {
      callFindUnique.mockResolvedValue(null);
      callCreate.mockResolvedValue({ id: "call_1" });

      await sendWebhook("call.initiated", { call_control_id: "ctrl_1" });

      expect(leadUpsert).not.toHaveBeenCalled();
      expect(callCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ leadId: undefined }) })
      );
    });

    it("does not touch leads for the outbound call.initiated echo (Call already exists)", async () => {
      callFindUnique.mockResolvedValue({ id: "call_1" });

      await sendWebhook("call.initiated", { call_control_id: "ctrl_1", from: "+15550000000", to: "+15559876543" });

      expect(leadUpsert).not.toHaveBeenCalled();
      expect(callCreate).not.toHaveBeenCalled();
    });
  });

  describe("call.hangup outcome mapping", () => {
    it("marks the call COMPLETED when it had been answered, regardless of hangup_cause", async () => {
      callFindUnique.mockResolvedValue({ id: "call_1", status: "IN_PROGRESS" });
      callUpdate.mockResolvedValue({ id: "call_1" });

      await sendWebhook("call.hangup", { call_control_id: "ctrl_1", hangup_cause: "normal_clearing" });

      expect(callUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", outcome: "normal_clearing" }) })
      );
      expect(finalizeDialOutcome).toHaveBeenCalledWith("call_1", "COMPLETED");
    });

    it.each([
      ["user_busy", "BUSY"],
      ["no_answer", "NO_ANSWER"],
      ["timeout", "NO_ANSWER"],
      ["originator_cancel", "CANCELED"],
      ["call_rejected", "FAILED"],
    ])("maps hangup_cause %s to status %s when the call was never answered", async (hangupCause, expectedStatus) => {
      callFindUnique.mockResolvedValue({ id: "call_1", status: "RINGING" });
      callUpdate.mockResolvedValue({ id: "call_1" });

      await sendWebhook("call.hangup", { call_control_id: "ctrl_1", hangup_cause: hangupCause });

      expect(callUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: expectedStatus, outcome: hangupCause }) })
      );
      expect(finalizeDialOutcome).toHaveBeenCalledWith("call_1", expectedStatus);
    });
  });
});
