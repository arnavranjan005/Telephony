const callCreate = jest.fn();
const callFindMany = jest.fn();
const callFindUnique = jest.fn();
const callUpdate = jest.fn();

jest.mock("../../src/config/prisma", () => ({
  prisma: {
    call: {
      create: (...args: unknown[]) => callCreate(...args),
      findMany: (...args: unknown[]) => callFindMany(...args),
      findUnique: (...args: unknown[]) => callFindUnique(...args),
      update: (...args: unknown[]) => callUpdate(...args),
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

jest.mock("../../src/services/callConversationService", () => ({
  handleCallerUtterance: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Call routes", () => {
  it("POST /api/calls/outbound creates a Call record and initiates the Telnyx call", async () => {
    callCreate.mockResolvedValue({ id: "call_1" });
    initiateOutboundCall.mockResolvedValue({ call_control_id: "ctrl_123" });
    callUpdate.mockResolvedValue({ id: "call_1", telnyxCallControlId: "ctrl_123", status: "INITIATED" });

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

  it("POST /api/calls/outbound returns 502 if Telnyx does not return a call_control_id", async () => {
    callCreate.mockResolvedValue({ id: "call_1" });
    initiateOutboundCall.mockResolvedValue({});

    const res = await request(app).post("/api/calls/outbound").send({ toNumber: "+15551234567" });

    expect(res.status).toBe(502);
    expect(callUpdate).not.toHaveBeenCalled();
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

  it("POST /api/calls/webhook acknowledges a validly signed call.hangup event and updates the call", async () => {
    verifyTelnyxSignature.mockReturnValue(true);
    callUpdate.mockResolvedValue({ id: "call_1", status: "COMPLETED" });

    const res = await request(app)
      .post("/api/calls/webhook")
      .send({ data: { event_type: "call.hangup", payload: { call_control_id: "ctrl_1" } } });

    expect(res.status).toBe(200);
    // Webhook processing happens after the immediate 200 ack; flush the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
    expect(callUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telnyxCallControlId: "ctrl_1" } })
    );
  });
});
