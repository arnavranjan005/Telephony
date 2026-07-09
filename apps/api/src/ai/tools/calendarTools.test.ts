const isSlotAvailable = jest.fn();
const createAppointment = jest.fn();
const appointmentCreate = jest.fn();

jest.mock("../../google-calendar/calendarService", () => ({
  isSlotAvailable: (...args: unknown[]) => isSlotAvailable(...args),
  createAppointment: (...args: unknown[]) => createAppointment(...args),
}));

jest.mock("@telephony/database", () => ({
  prisma: { appointment: { create: (...args: unknown[]) => appointmentCreate(...args) } },
}));

const cancelAppointmentById = jest.fn();
const findCancelableAppointmentId = jest.fn();
jest.mock("../../appointmentService", () => ({
  cancelAppointmentById: (...args: unknown[]) => cancelAppointmentById(...args),
  findCancelableAppointmentId: (...args: unknown[]) => findCancelableAppointmentId(...args),
}));

import { buildCalendarTools } from "./calendarTools";

describe("calendarTools", () => {
  const tools = buildCalendarTools({ leadId: "lead_1", callId: "call_1" });
  const checkAvailability = tools.find((t) => t.name === "check_appointment_availability")!;
  const scheduleAppointment = tools.find((t) => t.name === "schedule_appointment")!;
  const cancelAppointmentTool = tools.find((t) => t.name === "cancel_appointment")!;

  // schedule_appointment rejects any startTime that's already in the past
  // (see calendarTools.ts) - fixing "now" before the fixture dates below
  // keeps them in the future without hardcoding a moving-target date.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2024-06-01T00:00:00Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

  it("cancel_appointment cancels the explicitly given appointmentId without looking one up", async () => {
    cancelAppointmentById.mockResolvedValue({ outcome: "canceled", appointment: { id: "appt_explicit" } });

    const result = await cancelAppointmentTool.handler({ appointmentId: "appt_explicit" });

    expect(result).toEqual({ canceled: true, appointmentId: "appt_explicit" });
    expect(findCancelableAppointmentId).not.toHaveBeenCalled();
    expect(cancelAppointmentById).toHaveBeenCalledWith("appt_explicit");
  });

  it("cancel_appointment looks up the most recent cancelable appointment when no id is given", async () => {
    findCancelableAppointmentId.mockResolvedValue("appt_found");
    cancelAppointmentById.mockResolvedValue({ outcome: "canceled", appointment: { id: "appt_found" } });

    const result = await cancelAppointmentTool.handler({});

    expect(findCancelableAppointmentId).toHaveBeenCalledWith({ leadId: "lead_1", callId: "call_1" });
    expect(cancelAppointmentById).toHaveBeenCalledWith("appt_found");
    expect(result).toEqual({ canceled: true, appointmentId: "appt_found" });
  });

  it("cancel_appointment reports failure when there's nothing cancelable to find", async () => {
    findCancelableAppointmentId.mockResolvedValue(null);

    const result = await cancelAppointmentTool.handler({});

    expect(result).toEqual({ canceled: false, reason: "No cancelable appointment found for this lead" });
    expect(cancelAppointmentById).not.toHaveBeenCalled();
  });

  it("cancel_appointment is a no-op when there is no lead associated with the call", async () => {
    const [, , cancelTool] = buildCalendarTools({});

    const result = await cancelTool.handler({ appointmentId: "appt_1" });

    expect(result).toEqual({ canceled: false, reason: "No lead associated with this call" });
    expect(cancelAppointmentById).not.toHaveBeenCalled();
  });

  it("cancel_appointment surfaces not_cancelable as a clear failure reason", async () => {
    cancelAppointmentById.mockResolvedValue({ outcome: "not_cancelable", appointment: { id: "appt_1" } });

    const result = await cancelAppointmentTool.handler({ appointmentId: "appt_1" });

    expect(result).toEqual({ canceled: false, reason: "That appointment is already completed and can't be canceled" });
  });
});
