const appointmentFindUnique = jest.fn();
const appointmentFindFirst = jest.fn();
const appointmentUpdateMany = jest.fn();
const appointmentUpdate = jest.fn();
const appointmentFindUniqueOrThrow = jest.fn();
const cancelGoogleEvent = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    appointment: {
      findUnique: (...args: unknown[]) => appointmentFindUnique(...args),
      findFirst: (...args: unknown[]) => appointmentFindFirst(...args),
      updateMany: (...args: unknown[]) => appointmentUpdateMany(...args),
      update: (...args: unknown[]) => appointmentUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => appointmentFindUniqueOrThrow(...args),
    },
  },
  AppointmentStatus: {
    SCHEDULED: "SCHEDULED",
    CONFIRMED: "CONFIRMED",
    CANCELED: "CANCELED",
    COMPLETED: "COMPLETED",
  },
}));

jest.mock("./google-calendar/calendarService", () => ({
  cancelAppointment: (...args: unknown[]) => cancelGoogleEvent(...args),
}));

import { cancelAppointmentById, findCancelableAppointmentId } from "./appointmentService";

describe("appointmentService", () => {
  describe("cancelAppointmentById", () => {
    it("cancels a SCHEDULED appointment and deletes its linked Google event", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_1", status: "SCHEDULED", googleEventId: "evt_1" });
      appointmentUpdateMany.mockResolvedValue({ count: 1 });
      appointmentFindUniqueOrThrow.mockResolvedValue({ id: "appt_1", status: "CANCELED", googleEventId: "evt_1" });

      const result = await cancelAppointmentById("appt_1");

      expect(appointmentUpdateMany).toHaveBeenCalledWith({
        where: { id: "appt_1", status: { in: ["SCHEDULED", "CONFIRMED"] } },
        data: { status: "CANCELED" },
      });
      expect(cancelGoogleEvent).toHaveBeenCalledWith("evt_1");
      expect(result).toEqual({ outcome: "canceled", appointment: { id: "appt_1", status: "CANCELED", googleEventId: "evt_1" } });
    });

    it("skips the Google call when there is no linked event", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_2", status: "SCHEDULED", googleEventId: null });
      appointmentUpdateMany.mockResolvedValue({ count: 1 });
      appointmentFindUniqueOrThrow.mockResolvedValue({ id: "appt_2", status: "CANCELED", googleEventId: null });

      const result = await cancelAppointmentById("appt_2");

      expect(cancelGoogleEvent).not.toHaveBeenCalled();
      expect(result.outcome).toBe("canceled");
    });

    it("returns not_found for an unknown id", async () => {
      appointmentFindUnique.mockResolvedValue(null);

      const result = await cancelAppointmentById("missing");

      expect(result).toEqual({ outcome: "not_found" });
      expect(appointmentUpdateMany).not.toHaveBeenCalled();
    });

    it("is idempotent - repeating a cancel on an already-CANCELED appointment succeeds without re-calling Google", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_1", status: "CANCELED", googleEventId: "evt_1" });

      const result = await cancelAppointmentById("appt_1");

      expect(cancelGoogleEvent).not.toHaveBeenCalled();
      expect(appointmentUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "canceled", appointment: { id: "appt_1", status: "CANCELED", googleEventId: "evt_1" } });
    });

    it("reports not_cancelable for a COMPLETED appointment instead of forcing it to CANCELED", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_1", status: "COMPLETED", googleEventId: "evt_1" });

      const result = await cancelAppointmentById("appt_1");

      expect(appointmentUpdateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "not_cancelable", appointment: { id: "appt_1", status: "COMPLETED", googleEventId: "evt_1" } });
    });

    it("loses the claim race gracefully: if the conditional update matches nothing, reports the row's actual current state", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_1", status: "SCHEDULED", googleEventId: "evt_1" });
      appointmentUpdateMany.mockResolvedValue({ count: 0 });
      appointmentFindUniqueOrThrow.mockResolvedValue({ id: "appt_1", status: "COMPLETED", googleEventId: "evt_1" });

      const result = await cancelAppointmentById("appt_1");

      expect(cancelGoogleEvent).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "not_cancelable", appointment: { id: "appt_1", status: "COMPLETED", googleEventId: "evt_1" } });
    });

    it("reverts the claim if the Google cancel call fails, so the row isn't left CANCELED while still live on the calendar", async () => {
      appointmentFindUnique.mockResolvedValue({ id: "appt_1", status: "SCHEDULED", googleEventId: "evt_1" });
      appointmentUpdateMany.mockResolvedValue({ count: 1 });
      cancelGoogleEvent.mockRejectedValueOnce(new Error("Google API down"));

      await expect(cancelAppointmentById("appt_1")).rejects.toThrow("Google API down");

      expect(appointmentUpdate).toHaveBeenCalledWith({ where: { id: "appt_1" }, data: { status: "SCHEDULED" } });
    });
  });

  describe("findCancelableAppointmentId", () => {
    it("prefers a cancelable appointment scoped to the given callId", async () => {
      appointmentFindFirst.mockResolvedValueOnce({ id: "appt_scoped" });

      const id = await findCancelableAppointmentId({ leadId: "lead_1", callId: "call_1" });

      expect(id).toBe("appt_scoped");
      expect(appointmentFindFirst).toHaveBeenCalledWith({
        where: { leadId: "lead_1", callId: "call_1", status: { in: ["SCHEDULED", "CONFIRMED"] } },
        orderBy: { createdAt: "desc" },
      });
    });

    it("falls back to the lead's most recent cancelable appointment when none matches the callId", async () => {
      appointmentFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "appt_fallback" });

      const id = await findCancelableAppointmentId({ leadId: "lead_1", callId: "call_1" });

      expect(id).toBe("appt_fallback");
      expect(appointmentFindFirst).toHaveBeenLastCalledWith({
        where: { leadId: "lead_1", status: { in: ["SCHEDULED", "CONFIRMED"] } },
        orderBy: { createdAt: "desc" },
      });
    });

    it("returns null when there is nothing cancelable for the lead", async () => {
      appointmentFindFirst.mockResolvedValue(null);

      const id = await findCancelableAppointmentId({ leadId: "lead_1" });

      expect(id).toBeNull();
    });
  });
});
