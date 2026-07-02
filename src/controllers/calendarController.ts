import { Request, Response } from "express";
import { z } from "zod";
import { getAuthUrl, getOAuth2Client } from "../lib/google-calendar/googleCalendarClient";
import { createAppointment, getBusySlots, isSlotAvailable } from "../lib/google-calendar/calendarService";
import { prisma } from "../config/prisma";

export function getGoogleAuthUrl(_req: Request, res: Response) {
  res.json({ url: getAuthUrl() });
}

export async function handleOAuthCallback(req: Request, res: Response) {
  const { code } = req.query;
  if (typeof code !== "string") {
    return res.status(400).json({ error: "Missing 'code' query parameter" });
  }

  const oAuth2Client = getOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);

  res.json({
    message: "Save this refresh token as GOOGLE_REFRESH_TOKEN in your environment.",
    refresh_token: tokens.refresh_token,
  });
}

const busySchema = z.object({
  timeMin: z.string(),
  timeMax: z.string(),
});

export async function listBusySlots(req: Request, res: Response) {
  const parsed = busySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const busy = await getBusySlots(parsed.data.timeMin, parsed.data.timeMax);
  res.json({ busy });
}

const createAppointmentSchema = z.object({
  title: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  leadId: z.string().optional(),
  callId: z.string().optional(),
  attendeeEmail: z.string().email().optional(),
  notes: z.string().optional(),
});

export async function bookAppointment(req: Request, res: Response) {
  const parsed = createAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { title, startTime, endTime, leadId, callId, attendeeEmail, notes } = parsed.data;

  const available = await isSlotAvailable(startTime, endTime);
  if (!available) {
    return res.status(409).json({ error: "Requested time slot is not available" });
  }

  const event = await createAppointment({ summary: title, startTime, endTime, attendeeEmail });

  const appointment = await prisma.appointment.create({
    data: {
      title,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      googleEventId: event.eventId,
      leadId,
      callId,
      notes,
    },
  });

  res.status(201).json({ appointment, calendarEvent: event });
}
