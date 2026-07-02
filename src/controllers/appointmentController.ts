import { Request, Response } from "express";
import { prisma } from "../config/prisma";
import { cancelAppointment as cancelGoogleEvent } from "../lib/google-calendar/calendarService";
import { AppointmentStatus } from "@prisma/client";

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
  const appointment = await prisma.appointment.findUnique({ where: { id: req.params.appointmentId } });
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });

  if (appointment.googleEventId) {
    await cancelGoogleEvent(appointment.googleEventId);
  }

  const updated = await prisma.appointment.update({
    where: { id: appointment.id },
    data: { status: AppointmentStatus.CANCELED },
  });

  res.json({ appointment: updated });
}
