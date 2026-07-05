const appointmentFindMany = jest.fn();
const appointmentFindUnique = jest.fn();
const cancelAppointmentById = jest.fn();

jest.mock("@telephony/database", () => ({
  ...jest.requireActual("@prisma/client"),
  prisma: {
    appointment: {
      findMany: (...args: unknown[]) => appointmentFindMany(...args),
      findUnique: (...args: unknown[]) => appointmentFindUnique(...args),
    },
  },
}));

jest.mock("../../src/appointmentService", () => ({
  cancelAppointmentById: (...args: unknown[]) => cancelAppointmentById(...args),
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

  it("POST /api/appointments/:id/cancel cancels the appointment", async () => {
    cancelAppointmentById.mockResolvedValue({ outcome: "canceled", appointment: { id: "appt_1", status: "CANCELED" } });

    const res = await request(app).post("/api/appointments/appt_1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe("CANCELED");
    expect(cancelAppointmentById).toHaveBeenCalledWith("appt_1");
  });

  it("POST /api/appointments/:id/cancel returns 404 for an unknown appointment", async () => {
    cancelAppointmentById.mockResolvedValue({ outcome: "not_found" });

    const res = await request(app).post("/api/appointments/missing/cancel");

    expect(res.status).toBe(404);
  });

  it("POST /api/appointments/:id/cancel returns 409 when the appointment is already COMPLETED", async () => {
    cancelAppointmentById.mockResolvedValue({
      outcome: "not_cancelable",
      appointment: { id: "appt_1", status: "COMPLETED" },
    });

    const res = await request(app).post("/api/appointments/appt_1/cancel");

    expect(res.status).toBe(409);
  });

  it("POST /api/appointments/:id/cancel is idempotent - repeating it on an already-canceled appointment returns 200", async () => {
    cancelAppointmentById.mockResolvedValue({ outcome: "canceled", appointment: { id: "appt_1", status: "CANCELED" } });

    const res = await request(app).post("/api/appointments/appt_1/cancel");

    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe("CANCELED");
  });
});
