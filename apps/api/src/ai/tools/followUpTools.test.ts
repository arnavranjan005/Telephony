const createFollowUp = jest.fn();
const isWithinCallingHours = jest.fn();
const nextCallingWindowStart = jest.fn();

jest.mock("@telephony/domain", () => ({
  createFollowUp: (...args: unknown[]) => createFollowUp(...args),
  isWithinCallingHours: (...args: unknown[]) => isWithinCallingHours(...args),
  nextCallingWindowStart: (...args: unknown[]) => nextCallingWindowStart(...args),
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
});
