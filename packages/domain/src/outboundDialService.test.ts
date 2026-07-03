const callCreate = jest.fn();
const callUpdate = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    call: {
      create: (...args: unknown[]) => callCreate(...args),
      update: (...args: unknown[]) => callUpdate(...args),
    },
  },
  CallDirection: { OUTBOUND: "OUTBOUND" },
  CallStatus: { QUEUED: "QUEUED", INITIATED: "INITIATED", FAILED: "FAILED" },
}));

const initiateOutboundCall = jest.fn();
jest.mock("./telnyx/callService", () => ({
  initiateOutboundCall: (...args: unknown[]) => initiateOutboundCall(...args),
}));

const isNumberOnDnc = jest.fn();
jest.mock("./dncService", () => ({
  isNumberOnDnc: (...args: unknown[]) => isNumberOnDnc(...args),
}));

import { placeOutboundCall } from "./outboundDialService";

describe("placeOutboundCall", () => {
  it("skips dialing and never creates a Call row for a DNC-listed number", async () => {
    isNumberOnDnc.mockResolvedValue(true);

    const result = await placeOutboundCall("+15551234567", "lead_1");

    expect(result).toEqual({ outcome: "skipped_dnc" });
    expect(callCreate).not.toHaveBeenCalled();
    expect(initiateOutboundCall).not.toHaveBeenCalled();
  });

  it("dials and marks the call INITIATED on success", async () => {
    isNumberOnDnc.mockResolvedValue(false);
    callCreate.mockResolvedValue({ id: "call_1" });
    initiateOutboundCall.mockResolvedValue({ call_control_id: "ctrl_1" });
    callUpdate.mockResolvedValue({ id: "call_1" });

    const result = await placeOutboundCall("+15551234567", "lead_1");

    expect(result).toEqual({ outcome: "dialed", callId: "call_1" });
    expect(callUpdate).toHaveBeenCalledWith({
      where: { id: "call_1" },
      data: { telnyxCallControlId: "ctrl_1", status: "INITIATED" },
    });
  });

  it("marks the call FAILED and returns a failed outcome when Telnyx errors", async () => {
    isNumberOnDnc.mockResolvedValue(false);
    callCreate.mockResolvedValue({ id: "call_2" });
    initiateOutboundCall.mockRejectedValue(new Error("Telnyx unavailable"));
    callUpdate.mockResolvedValue({ id: "call_2" });

    const result = await placeOutboundCall("+15551234567", "lead_1");

    expect(result).toEqual({ outcome: "failed", error: "Telnyx unavailable" });
    expect(callUpdate).toHaveBeenCalledWith({ where: { id: "call_2" }, data: { status: "FAILED" } });
  });

  it("marks the call FAILED when Telnyx returns no call_control_id", async () => {
    isNumberOnDnc.mockResolvedValue(false);
    callCreate.mockResolvedValue({ id: "call_3" });
    initiateOutboundCall.mockResolvedValue({});
    callUpdate.mockResolvedValue({ id: "call_3" });

    const result = await placeOutboundCall("+15551234567", "lead_1");

    expect(result.outcome).toBe("failed");
    expect(callUpdate).toHaveBeenCalledWith({ where: { id: "call_3" }, data: { status: "FAILED" } });
  });
});
