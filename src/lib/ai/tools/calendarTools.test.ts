const isSlotAvailable = jest.fn();
const createAppointment = jest.fn();
const appointmentCreate = jest.fn();

jest.mock("../../google-calendar/calendarService", () => ({
  isSlotAvailable: (...args: unknown[]) => isSlotAvailable(...args),
  createAppointment: (...args: unknown[]) => createAppointment(...args),
}));

jest.mock("../../../config/prisma", () => ({
  prisma: { appointment: { create: (...args: unknown[]) => appointmentCreate(...args) } },
}));

import { buildCalendarTools } from "./calendarTools";

describe("calendarTools", () => {
  const tools = buildCalendarTools({ leadId: "lead_1", callId: "call_1" });
  const checkAvailability = tools.find((t) => t.name === "check_appointment_availability")!;
  const scheduleAppointment = tools.find((t) => t.name === "schedule_appointment")!;

  it("check_appointment_availability reports availability from the calendar service", async () => {
    isSlotAvailable.mockResolvedValue(true);

    const result = await checkAvailability.handler({
      startTime: "2025-01-15T14:00:00Z",
      endTime: "2025-01-15T14:30:00Z",
    });

    expect(result).toEqual({ available: true });
    expect(isSlotAvailable).toHaveBeenCalledWith("2025-01-15T14:00:00Z", "2025-01-15T14:30:00Z");
  });

  it("schedule_appointment refuses to book when the slot is unavailable", async () => {
    isSlotAvailable.mockResolvedValue(false);

    const result = await scheduleAppointment.handler({
      title: "Sales call",
      startTime: "2025-01-15T14:00:00Z",
      endTime: "2025-01-15T14:30:00Z",
    });

    expect(result).toEqual({ booked: false, reason: "Slot is no longer available" });
    expect(createAppointment).not.toHaveBeenCalled();
    expect(appointmentCreate).not.toHaveBeenCalled();
  });

  it("schedule_appointment creates the Google event and the local record, linking lead/call context", async () => {
    isSlotAvailable.mockResolvedValue(true);
    createAppointment.mockResolvedValue({ eventId: "evt_1", htmlLink: null, start: "", end: "" });
    appointmentCreate.mockResolvedValue({ id: "appt_1" });

    const result = await scheduleAppointment.handler({
      title: "Sales call",
      startTime: "2025-01-15T14:00:00Z",
      endTime: "2025-01-15T14:30:00Z",
      attendeeEmail: "lead@example.com",
    });

    expect(result).toEqual({ booked: true, appointmentId: "appt_1", calendarEventId: "evt_1" });
    expect(createAppointment).toHaveBeenCalledWith({
      summary: "Sales call",
      startTime: "2025-01-15T14:00:00Z",
      endTime: "2025-01-15T14:30:00Z",
      attendeeEmail: "lead@example.com",
    });
    expect(appointmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Sales call",
        googleEventId: "evt_1",
        leadId: "lead_1",
        callId: "call_1",
      }),
    });
  });
});
