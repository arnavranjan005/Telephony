const callCreate = jest.fn();
const callUpdate = jest.fn();
const followUpUpdateMany = jest.fn();
const campaignContactFindUnique = jest.fn();
const campaignContactUpdate = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    call: {
      create: (...args: unknown[]) => callCreate(...args),
      update: (...args: unknown[]) => callUpdate(...args),
    },
    followUp: {
      updateMany: (...args: unknown[]) => followUpUpdateMany(...args),
    },
    campaignContact: {
      findUnique: (...args: unknown[]) => campaignContactFindUnique(...args),
      update: (...args: unknown[]) => campaignContactUpdate(...args),
    },
  },
  CallDirection: { OUTBOUND: "OUTBOUND" },
  CallStatus: {
    QUEUED: "QUEUED",
    INITIATED: "INITIATED",
    COMPLETED: "COMPLETED",
    BUSY: "BUSY",
    NO_ANSWER: "NO_ANSWER",
    CANCELED: "CANCELED",
    FAILED: "FAILED",
  },
  FollowUpStatus: { CALLING: "CALLING", COMPLETED: "COMPLETED", FAILED: "FAILED" },
  CampaignContactStatus: { CALLING: "CALLING", CALLED: "CALLED", FAILED: "FAILED", SKIPPED_DNC: "SKIPPED_DNC" },
}));

const initiateOutboundCall = jest.fn();
jest.mock("./telnyx/callService", () => ({
  initiateOutboundCall: (...args: unknown[]) => initiateOutboundCall(...args),
}));

const isNumberOnDnc = jest.fn();
jest.mock("./dncService", () => ({
  isNumberOnDnc: (...args: unknown[]) => isNumberOnDnc(...args),
}));

import { finalizeDialOutcome, placeOutboundCall } from "./outboundDialService";

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

describe("finalizeDialOutcome", () => {
  it("marks a still-CALLING follow-up COMPLETED and a still-CALLING campaign contact CALLED when the call completed", async () => {
    followUpUpdateMany.mockResolvedValue({ count: 1 });
    campaignContactFindUnique.mockResolvedValue({ id: "cc_1", status: "CALLING" });

    await finalizeDialOutcome("call_1", "COMPLETED" as never);

    expect(followUpUpdateMany).toHaveBeenCalledWith({
      where: { callId: "call_1", status: "CALLING" },
      data: { status: "COMPLETED" },
    });
    expect(campaignContactUpdate).toHaveBeenCalledWith({ where: { id: "cc_1" }, data: { status: "CALLED" } });
  });

  it.each(["BUSY", "NO_ANSWER", "CANCELED", "FAILED"])(
    "marks a still-CALLING follow-up and campaign contact FAILED when the call resolves to %s",
    async (callStatus) => {
      followUpUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUnique.mockResolvedValue({ id: "cc_1", status: "CALLING" });

      await finalizeDialOutcome("call_1", callStatus as never);

      expect(followUpUpdateMany).toHaveBeenCalledWith({
        where: { callId: "call_1", status: "CALLING" },
        data: { status: "FAILED" },
      });
      expect(campaignContactUpdate).toHaveBeenCalledWith({ where: { id: "cc_1" }, data: { status: "FAILED" } });
    }
  );

  it("does not touch a campaign contact that's no longer CALLING (e.g. already SKIPPED_DNC), and is a no-op on a redelivered webhook", async () => {
    followUpUpdateMany.mockResolvedValue({ count: 0 }); // no FollowUp row still CALLING for this callId
    campaignContactFindUnique.mockResolvedValue({ id: "cc_1", status: "SKIPPED_DNC" });

    await finalizeDialOutcome("call_1", "COMPLETED" as never);

    expect(campaignContactUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op when no campaign contact is linked to the call at all", async () => {
    followUpUpdateMany.mockResolvedValue({ count: 1 });
    campaignContactFindUnique.mockResolvedValue(null);

    await finalizeDialOutcome("call_1", "COMPLETED" as never);

    expect(campaignContactUpdate).not.toHaveBeenCalled();
  });
});
