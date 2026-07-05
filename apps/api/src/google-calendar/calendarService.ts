import { getCalendarClient } from "./googleCalendarClient";
import { env } from "@telephony/config";

export interface FreeBusySlot {
  start: string;
  end: string;
}

export interface CreateAppointmentInput {
  summary: string;
  description?: string;
  startTime: string;
  endTime: string;
  attendeeEmail?: string;
  timeZone?: string;
}

export interface CreatedAppointment {
  eventId: string;
  htmlLink: string | null;
  start: string;
  end: string;
}

/**
 * Returns busy time ranges for the configured calendar within [timeMin, timeMax],
 * so callers can compute free slots and avoid double-booking.
 */
export async function getBusySlots(timeMin: string, timeMax: string): Promise<FreeBusySlot[]> {
  const calendar = getCalendarClient();
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: env.GOOGLE_CALENDAR_ID }],
    },
  });

  const busy = response.data.calendars?.[env.GOOGLE_CALENDAR_ID]?.busy ?? [];
  return busy
    .filter((slot) => slot.start && slot.end)
    .map((slot) => ({ start: slot.start as string, end: slot.end as string }));
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Checks whether a candidate [startTime, endTime) window is free by
 * cross-referencing the calendar's busy blocks.
 */
export async function isSlotAvailable(startTime: string, endTime: string): Promise<boolean> {
  const busySlots = await getBusySlots(startTime, endTime);
  const start = new Date(startTime);
  const end = new Date(endTime);

  return !busySlots.some((slot) => overlaps(start, end, new Date(slot.start), new Date(slot.end)));
}

export async function createAppointment(input: CreateAppointmentInput): Promise<CreatedAppointment> {
  const calendar = getCalendarClient();

  // sendUpdates defaults to "none" on Google's API - without it, a caller who
  // gave their email would never actually get a calendar invite.
  const response = await calendar.events.insert({
    calendarId: env.GOOGLE_CALENDAR_ID,
    sendUpdates: "all",
    requestBody: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.startTime, timeZone: input.timeZone ?? "UTC" },
      end: { dateTime: input.endTime, timeZone: input.timeZone ?? "UTC" },
      attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : undefined,
    },
  });

  return {
    eventId: response.data.id as string,
    htmlLink: response.data.htmlLink ?? null,
    start: response.data.start?.dateTime ?? input.startTime,
    end: response.data.end?.dateTime ?? input.endTime,
  };
}

export async function cancelAppointment(eventId: string): Promise<void> {
  const calendar = getCalendarClient();
  // sendUpdates defaults to "none" - without it, an attendee who was invited
  // would never find out the appointment was canceled.
  await calendar.events.delete({ calendarId: env.GOOGLE_CALENDAR_ID, eventId, sendUpdates: "all" });
}
