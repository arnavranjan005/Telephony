const createFollowUp = jest.fn();
const isWithinCallingHours = jest.fn();
const nextCallingWindowStart = jest.fn();
const cancelFollowUp = jest.fn();
const findCancelableFollowUpId = jest.fn();

jest.mock("@telephony/domain", () => ({
  createFollowUp: (...args: unknown[]) => createFollowUp(...args),
  isWithinCallingHours: (...args: unknown[]) => isWithinCallingHours(...args),
  nextCallingWindowStart: (...args: unknown[]) => nextCallingWindowStart(...args),
  cancelFollowUp: (...args: unknown[]) => cancelFollowUp(...args),
  findCancelableFollowUpId: (...args: unknown[]) => findCancelableFollowUpId(...args),
}));

import { buildFollowUpTools } from "./followUpTools";

describe("followUpTools", () => {
  beforeEach(() => {
    isWithinCallingHours.mockReturnValue(true); // default: requested time is legal
  });

  it("schedule_followup creates a follow-up bound to the current lead", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1", scheduledAt: new Date("2025-01-16T18:00:00Z") });

    const [scheduleFollowUp] = buildFollowUpTools({ leadId: "lead_1", phoneNumber: "+12125551234" });
    const result = await scheduleFollowUp.handler({
      scheduledAt: "2025-01-16T18:00:00Z",
      reason: "wants a callback Thursday",
    });

    expect(result).toMatchObject({ scheduled: true, followUpId: "fu_1" });
    expect(createFollowUp).toHaveBeenCalledWith({
      leadId: "lead_1",
      scheduledAt: new Date("2025-01-16T18:00:00Z"),
      reason: "wants a callback Thursday",
    });
  });

  it("schedule_followup is a no-op when there is no lead associated with the call", async () => {
    const [scheduleFollowUp] = buildFollowUpTools({});
    const result = await scheduleFollowUp.handler({ scheduledAt: "2025-01-16T18:00:00Z" });

    expect(result).toEqual({ scheduled: false, reason: "No lead associated with this call" });
    expect(createFollowUp).not.toHaveBeenCalled();
  });

  it("schedule_followup does not create anything and suggests an in-window time when the caller's requested time is outside calling hours", async () => {
    isWithinCallingHours.mockReturnValue(false);
    const suggested = new Date("2025-01-17T13:00:00Z");
    nextCallingWindowStart.mockReturnValue(suggested);

    const [scheduleFollowUp] = buildFollowUpTools({ leadId: "lead_1", phoneNumber: "+12125551234" });
    const result = await scheduleFollowUp.handler({ scheduledAt: "2025-01-16T23:00:00Z" });

    expect(result).toEqual({
      scheduled: false,
      reason: "Requested time is outside the legal calling window (8am-9pm local to this number)",
      suggestedTime: suggested.toISOString(),
    });
    expect(createFollowUp).not.toHaveBeenCalled();
    expect(isWithinCallingHours).toHaveBeenCalledWith("+12125551234", new Date("2025-01-16T23:00:00Z"));
  });

  it("schedule_followup skips the calling-hours check (and just books it) when there's no phone number to check against", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1", scheduledAt: new Date("2025-01-16T18:00:00Z") });

    const [scheduleFollowUp] = buildFollowUpTools({ leadId: "lead_1" });
    const result = await scheduleFollowUp.handler({ scheduledAt: "2025-01-16T18:00:00Z" });

    expect(result).toMatchObject({ scheduled: true });
    expect(isWithinCallingHours).not.toHaveBeenCalled();
  });

  it("schedule_followup inherits the current call's streaming mode onto the scheduled callback", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1", scheduledAt: new Date("2025-01-16T18:00:00Z") });

    const [scheduleFollowUp] = buildFollowUpTools({
      leadId: "lead_1",
      phoneNumber: "+12125551234",
      streamingEnabled: true,
    });
    await scheduleFollowUp.handler({ scheduledAt: "2025-01-16T18:00:00Z" });

    expect(createFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "lead_1", streamingEnabled: true })
    );
  });

  describe("cancel_followup", () => {
    it("cancels the explicitly given followUpId without looking one up", async () => {
      cancelFollowUp.mockResolvedValue({ outcome: "canceled", followUp: { id: "fu_explicit" } });

      const [, cancelTool] = buildFollowUpTools({ leadId: "lead_1" });
      const result = await cancelTool.handler({ followUpId: "fu_explicit" });

      expect(result).toEqual({ canceled: true, followUpId: "fu_explicit" });
      expect(findCancelableFollowUpId).not.toHaveBeenCalled();
      expect(cancelFollowUp).toHaveBeenCalledWith("fu_explicit");
    });

    it("looks up the most recent pending follow-up, scoped to the current call, when no id is given", async () => {
      findCancelableFollowUpId.mockResolvedValue("fu_found");
      cancelFollowUp.mockResolvedValue({ outcome: "canceled", followUp: { id: "fu_found" } });

      const [, cancelTool] = buildFollowUpTools({ leadId: "lead_1", callId: "call_1" });
      const result = await cancelTool.handler({});

      expect(findCancelableFollowUpId).toHaveBeenCalledWith({ leadId: "lead_1", callId: "call_1" });
      expect(cancelFollowUp).toHaveBeenCalledWith("fu_found");
      expect(result).toEqual({ canceled: true, followUpId: "fu_found" });
    });

    it("reports failure when there's no pending callback to find", async () => {
      findCancelableFollowUpId.mockResolvedValue(null);

      const [, cancelTool] = buildFollowUpTools({ leadId: "lead_1" });
      const result = await cancelTool.handler({});

      expect(result).toEqual({ canceled: false, reason: "No pending callback found for this lead" });
      expect(cancelFollowUp).not.toHaveBeenCalled();
    });

    it("is a no-op when there is no lead associated with the call", async () => {
      const [, cancelTool] = buildFollowUpTools({});
      const result = await cancelTool.handler({ followUpId: "fu_1" });

      expect(result).toEqual({ canceled: false, reason: "No lead associated with this call" });
      expect(cancelFollowUp).not.toHaveBeenCalled();
    });

    it("surfaces not_cancelable as a clear failure reason", async () => {
      cancelFollowUp.mockResolvedValue({ outcome: "not_cancelable", followUp: { id: "fu_1" } });

      const [, cancelTool] = buildFollowUpTools({ leadId: "lead_1" });
      const result = await cancelTool.handler({ followUpId: "fu_1" });

      expect(result).toEqual({
        canceled: false,
        reason: "That callback is already in progress or resolved and can't be canceled",
      });
    });
  });
});
