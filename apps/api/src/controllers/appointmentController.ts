import { Request, Response } from "express";
import { prisma, AppointmentStatus } from "@telephony/database";
import { cancelAppointmentById } from "../appointmentService";

export async function listAppointments(req: Request, res: Response) {
  const status = req.query.status as AppointmentStatus | undefined;
  const appointments = await prisma.appointment.findMany({
    where: status ? { status } : undefined,
    orderBy: { startTime: "asc" },
    include: { lead: true },
  });
  res.json({ appointments });
}

export async function getAppointment(req: Request, res: Response) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: req.params.appointmentId },
    include: { lead: true, call: true },
  });
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });
  res.json({ appointment });
}

export async function cancelAppointment(req: Request, res: Response) {
  const result = await cancelAppointmentById(req.params.appointmentId);
  if (result.outcome === "not_found") return res.status(404).json({ error: "Appointment not found" });
  if (result.outcome === "not_cancelable") {
    return res.status(409).json({ error: "Appointment can no longer be canceled", appointment: result.appointment });
  }
  res.json({ appointment: result.appointment });
}
