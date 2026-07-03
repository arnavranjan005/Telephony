const callCreate = jest.fn();
const callFindMany = jest.fn();
const callFindUnique = jest.fn();
const callUpdate = jest.fn();
const leadUpsert = jest.fn();

jest.mock("../../src/config/prisma", () => ({
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

const initiateOutboundCall = jest.fn();
const answerCall = jest.fn();
const speakText = jest.fn();
const startTranscription = jest.fn();

jest.mock("../../src/lib/telnyx/callService", () => ({
  initiateOutboundCall: (...args: unknown[]) => initiateOutboundCall(...args),
  answerCall: (...args: unknown[]) => answerCall(...args),
  speakText: (...args: unknown[]) => speakText(...args),
  startTranscription: (...args: unknown[]) => startTranscription(...args),
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
jest.mock("../../src/lib/telnyx/webhookVerifier", () => ({
  verifyTelnyxSignature: (...args: unknown[]) => verifyTelnyxSignature(...args),
}));

const isNumberOnDnc = jest.fn();
jest.mock("../../src/lib/compliance/dncService", () => ({
  isNumberOnDnc: (...args: unknown[]) => isNumberOnDnc(...args),
}));

jest.mock("../../src/services/callConversationService", () => ({
  handleCallerUtterance: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Call routes", () => {
  beforeEach(() => {
    isNumberOnDnc.mockResolvedValue(false);
  });

  it("POST /api/calls/outbound creates a Call record and initiates the Telnyx call", async () => {
    callCreate.mockResolvedValue({ id: "call_1" });
    initiateOutboundCall.mockResolvedValue({ call_control_id: "ctrl_123" });
    callUpdate.mockResolvedValue({ id: "call_1", telnyxCallControlId: "ctrl_123", status: "INITIATED" });
    callFindUnique.mockResolvedValue({ id: "call_1", telnyxCallControlId: "ctrl_123", status: "INITIATED" });

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(201);
    expect(res.body.call.telnyxCallControlId).toBe("ctrl_123");
    expect(initiateOutboundCall).toHaveBeenCalledWith("+15551234567", { callId: "call_1" });
  });

  it("POST /api/calls/outbound rejects a request missing toNumber", async () => {
    const res = await request(app).post("/api/calls/outbound").send({});

    expect(res.status).toBe(400);
    expect(callCreate).not.toHaveBeenCalled();
  });

  it("POST /api/calls/outbound returns 403 and never dials when the number is on the DNC list", async () => {
    isNumberOnDnc.mockResolvedValue(true);

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(403);
    expect(callCreate).not.toHaveBeenCalled();
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it("POST /api/calls/outbound returns 502 if Telnyx does not return a call_control_id", async () => {
    callCreate.mockResolvedValue({ id: "call_1" });
    initiateOutboundCall.mockResolvedValue({});
    callUpdate.mockResolvedValue({ id: "call_1", status: "FAILED" });

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(502);
    expect(callUpdate).toHaveBeenCalledWith({ where: { id: "call_1" }, data: { status: "FAILED" } });
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
      expect(answerCall).toHaveBeenCalledWith("ctrl_1");
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
    });
  });
});
