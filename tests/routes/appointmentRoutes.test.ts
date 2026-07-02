const appointmentFindMany = jest.fn();
const appointmentFindUnique = jest.fn();
const appointmentUpdate = jest.fn();
const cancelAppointmentEvent = jest.fn();

jest.mock("../../src/config/prisma", () => ({
  prisma: {
    appointment: {
      findMany: (...args: unknown[]) => appointmentFindMany(...args),
      findUnique: (...args: unknown[]) => appointmentFindUnique(...args),
      update: (...args: unknown[]) => appointmentUpdate(...args),
    },
  },
}));

jest.mock("../../src/lib/google-calendar/calendarService", () => ({
  cancelAppointment: (...args: unknown[]) => cancelAppointmentEvent(...args),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Appointment routes", () => {
  it("GET /api/appointments lists appointments", async () => {
    appointmentFindMany.mockResolvedValue([{ id: "appt_1" }]);

    const res = await request(app).get("/api/appointments");

    expect(res.status).toBe(200);
    expect(res.body.appointments).toHaveLength(1);
  });

  it("GET /api/appointments/:id returns 404 when not found", async () => {
    appointmentFindUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/appointments/missing");

    expect(res.status).toBe(404);
  });

  it("POST /api/appointments/:id/cancel cancels the Google event and marks the appointment canceled", async () => {
    appointmentFindUnique.mockResolvedValue({ id: "appt_1", googleEventId: "evt_1" });
    appointmentUpdate.mockResolvedValue({ id: "appt_1", status: "CANCELED" });

    const res = await request(app).post("/api/appointments/appt_1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe("CANCELED");
    expect(cancelAppointmentEvent).toHaveBeenCalledWith("evt_1");
    expect(appointmentUpdate).toHaveBeenCalledWith({
      where: { id: "appt_1" },
      data: { status: "CANCELED" },
    });
  });

  it("POST /api/appointments/:id/cancel skips the Google Calendar call when there is no linked event", async () => {
    appointmentFindUnique.mockResolvedValue({ id: "appt_2", googleEventId: null });
    appointmentUpdate.mockResolvedValue({ id: "appt_2", status: "CANCELED" });

    const res = await request(app).post("/api/appointments/appt_2/cancel");

    expect(res.status).toBe(200);
    expect(cancelAppointmentEvent).not.toHaveBeenCalled();
  });

  it("POST /api/appointments/:id/cancel returns 404 for an unknown appointment", async () => {
    appointmentFindUnique.mockResolvedValue(null);

    const res = await request(app).post("/api/appointments/missing/cancel");

    expect(res.status).toBe(404);
    expect(appointmentUpdate).not.toHaveBeenCalled();
  });

  it("POST /api/appointments/:id/cancel is idempotent - repeating it on an already-canceled appointment does not re-call Google", async () => {
    appointmentFindUnique.mockResolvedValue({ id: "appt_1", googleEventId: "evt_1", status: "CANCELED" });

    const res = await request(app).post("/api/appointments/appt_1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe("CANCELED");
    expect(cancelAppointmentEvent).not.toHaveBeenCalled();
    expect(appointmentUpdate).not.toHaveBeenCalled();
  });
});
