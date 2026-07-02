const createFollowUp = jest.fn();

jest.mock("../../../services/followUpService", () => ({
  createFollowUp: (...args: unknown[]) => createFollowUp(...args),
}));

import { buildFollowUpTools } from "./followUpTools";

describe("followUpTools", () => {
  it("schedule_followup creates a follow-up bound to the current lead", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1", scheduledAt: new Date("2025-01-16T18:00:00Z") });

    const [scheduleFollowUp] = buildFollowUpTools({ leadId: "lead_1" });
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
});
