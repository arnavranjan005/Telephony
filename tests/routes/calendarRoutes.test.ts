const appointmentCreate = jest.fn();

jest.mock("../../src/config/prisma", () => ({
  prisma: {
    appointment: {
      create: (...args: unknown[]) => appointmentCreate(...args),
    },
  },
}));

const isSlotAvailable = jest.fn();
const createAppointment = jest.fn();
const cancelAppointment = jest.fn();

jest.mock("../../src/lib/google-calendar/calendarService", () => ({
  isSlotAvailable: (...args: unknown[]) => isSlotAvailable(...args),
  createAppointment: (...args: unknown[]) => createAppointment(...args),
  cancelAppointment: (...args: unknown[]) => cancelAppointment(...args),
  getBusySlots: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

const bookingBody = {
  title: "Consultation",
  startTime: "2025-01-15T14:00:00Z",
  endTime: "2025-01-15T14:30:00Z",
  attendeeEmail: "lead@example.com",
};

describe("Calendar routes", () => {
  it("POST /api/calendar/appointments returns 409 when the slot is unavailable and never touches Google/DB", async () => {
    isSlotAvailable.mockResolvedValue(false);

    const res = await request(app).post("/api/calendar/appointments").send(bookingBody);

    expect(res.status).toBe(409);
    expect(createAppointment).not.toHaveBeenCalled();
    expect(appointmentCreate).not.toHaveBeenCalled();
  });

  it("POST /api/calendar/appointments books the event and persists the appointment on success", async () => {
    isSlotAvailable.mockResolvedValue(true);
    createAppointment.mockResolvedValue({ eventId: "evt_1", htmlLink: null, start: "", end: "" });
    appointmentCreate.mockResolvedValue({ id: "appt_1", googleEventId: "evt_1" });

    const res = await request(app).post("/api/calendar/appointments").send(bookingBody);

    expect(res.status).toBe(201);
    expect(res.body.appointment.id).toBe("appt_1");
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("compensates by deleting the Google event when the DB write fails after booking", async () => {
    isSlotAvailable.mockResolvedValue(true);
    createAppointment.mockResolvedValue({ eventId: "evt_1", htmlLink: null, start: "", end: "" });
    appointmentCreate.mockRejectedValue(new Error("DB unavailable"));
    cancelAppointment.mockResolvedValue(undefined);

    const res = await request(app).post("/api/calendar/appointments").send(bookingBody);

    expect(res.status).toBe(500);
    expect(cancelAppointment).toHaveBeenCalledWith("evt_1");
  });

  it("still fails the request (without throwing) if the compensating delete itself fails", async () => {
    isSlotAvailable.mockResolvedValue(true);
    createAppointment.mockResolvedValue({ eventId: "evt_1", htmlLink: null, start: "", end: "" });
    appointmentCreate.mockRejectedValue(new Error("DB unavailable"));
    cancelAppointment.mockRejectedValue(new Error("Google API down"));

    const res = await request(app).post("/api/calendar/appointments").send(bookingBody);

    expect(res.status).toBe(500);
    expect(cancelAppointment).toHaveBeenCalledWith("evt_1");
  });
});
