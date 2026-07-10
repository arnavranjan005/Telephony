import { z } from "zod";
import { ToolDefinition } from "../types";
import { createAppointment, isSlotAvailable } from "../../google-calendar/calendarService";
import { cancelAppointmentById, findCancelableAppointmentId } from "../../appointmentService";
import { prisma } from "@telephony/database";
import { callEventBus } from "../../sse/eventBus";

export interface CalendarToolContext {
  leadId?: string;
  callId?: string;
}

// Reuses the same z.string().email() validator apps/api/src/controllers/calendarController.ts
// already applies to this exact field over REST, rather than a second, independently-drifting
// regex. Only validates the *shape* of a single already-normalized string the model hands us -
// not for scanning free-form transcript text. Extracting an email out of noisy ASR speech (a
// caller spelling one out loud - "john dot doe at gmail dot com") is exactly what an LLM is good
// at and a regex isn't, so that job is left to the model (see SYSTEM_PROMPT in
// callConversationService.ts, which already has the full transcript in every turn's message
// history). This only catches the narrower failure mode of a malformed value slipping through to
// Google's API - trimmed first since the model's output can carry incidental whitespace that
// would otherwise fail validation despite the address itself being fine.
const emailShapeSchema = z.string().trim().email();

/**
 * Builds the calendar-related tool definitions the AI agent can call during a
 * conversation. Bound to a specific call/lead so bookings made mid-call are
 * automatically linked back to the right records.
 */
export function buildCalendarTools(context: CalendarToolContext): ToolDefinition[] {
  const checkAvailability: ToolDefinition = {
    name: "check_appointment_availability",
    description:
      "Check whether a proposed appointment time slot is free on the calendar before booking it. There is no " +
      "minimum lead time - a slot 10 minutes or even 1 minute from now is checkable and bookable like any other, " +
      "as long as it's in the future and free. Don't assume or tell the caller a booking needs more advance " +
      "notice than that; check first rather than refusing based on how soon it is.",
    parameters: {
      type: "object",
      properties: {
        startTime: { type: "string", description: "ISO 8601 start datetime, e.g. 2025-01-15T14:00:00Z" },
        endTime: { type: "string", description: "ISO 8601 end datetime, e.g. 2025-01-15T14:30:00Z" },
      },
      required: ["startTime", "endTime"],
    },
    handler: async (args) => {
      const available = await isSlotAvailable(args.startTime as string, args.endTime as string);
      return { available };
    },
  };

  const scheduleAppointment: ToolDefinition = {
    name: "schedule_appointment",
    description:
      "Book an appointment on the calendar for the current lead/caller. Only call this after confirming availability and getting the caller's verbal confirmation. " +
      "If the caller already has an appointment booked and wants a different time instead, call cancel_appointment first. " +
      "There is no minimum lead time - the only timing requirement is that startTime is in the future and the slot is " +
      "free, so a request for a few minutes from now is valid; check it with check_appointment_availability and book " +
      "it rather than refusing or telling the caller it needs more advance notice.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the appointment" },
        startTime: { type: "string", description: "ISO 8601 start datetime" },
        endTime: { type: "string", description: "ISO 8601 end datetime" },
        attendeeEmail: { type: "string", description: "Caller's email address, if known" },
      },
      required: ["title", "startTime", "endTime"],
    },
    handler: async (args) => {
      const startTime = args.startTime as string;
      const endTime = args.endTime as string;
      let attendeeEmail = args.attendeeEmail as string | undefined;

      // Calendar availability alone doesn't rule out a stale/hallucinated
      // past date - an empty slot in the past is still "available" by that
      // check alone, so it needs its own explicit rejection.
      if (new Date(startTime).getTime() <= Date.now()) {
        return { booked: false, reason: "Requested time is in the past" };
      }

      // A shape check on the model's own (already-normalized) output, not an
      // attempt to parse one out of raw transcript text - see the comment on
      // emailShapeSchema above. Catches a garbled value before it reaches
      // Google's API instead of silently sending it or erroring obscurely.
      if (attendeeEmail) {
        const parsed = emailShapeSchema.safeParse(attendeeEmail);
        if (!parsed.success) {
          return {
            booked: false,
            reason: "attendeeEmail doesn't look like a valid email address - confirm the spelling with the caller and try again",
          };
        }
        attendeeEmail = parsed.data;
      } else if (context.leadId) {
        // The model is instructed (SYSTEM_PROMPT, get_lead_email's description) to call
        // get_lead_email and relay its result here itself - this is a deterministic backstop for
        // when it skips that step or drops the value across the two separate tool calls, so a
        // lead with a real email on file still gets a calendar invite rather than silently none.
        const lead = await prisma.lead.findUnique({ where: { id: context.leadId }, select: { email: true } });
        attendeeEmail = lead?.email ?? undefined;
      }

      const available = await isSlotAvailable(startTime, endTime);
      if (!available) {
        return { booked: false, reason: "Slot is no longer available" };
      }

      const event = await createAppointment({
        summary: args.title as string,
        startTime,
        endTime,
        attendeeEmail,
      });

      const appointment = await prisma.appointment.create({
        data: {
          title: args.title as string,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          googleEventId: event.eventId,
          leadId: context.leadId,
          callId: context.callId,
        },
      });

      callEventBus.publishGlobal("appointment.created", { appointment });
      return { booked: true, appointmentId: appointment.id, calendarEventId: event.eventId };
    },
  };

  const cancelAppointmentTool: ToolDefinition = {
    name: "cancel_appointment",
    description:
      "Cancel a previously booked appointment for this lead/caller - e.g. the caller wants a different time or no longer wants it. " +
      "Call this BEFORE booking a replacement with schedule_appointment, so the old slot doesn't stay booked alongside the new one. " +
      "If you already know the appointmentId from an earlier schedule_appointment result in this conversation, pass it; " +
      "otherwise leave it out and the most recent appointment for this lead will be canceled.",
    parameters: {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "The appointment id to cancel, if already known" },
      },
    },
    handler: async (args) => {
      if (!context.leadId) {
        return { canceled: false, reason: "No lead associated with this call" };
      }

      const appointmentId =
        (args.appointmentId as string | undefined) ??
        (await findCancelableAppointmentId({ leadId: context.leadId, callId: context.callId }));

      if (!appointmentId) {
        return { canceled: false, reason: "No cancelable appointment found for this lead" };
      }

      const result = await cancelAppointmentById(appointmentId);
      if (result.outcome === "not_found") {
        return { canceled: false, reason: "Appointment not found" };
      }
      if (result.outcome === "not_cancelable") {
        return { canceled: false, reason: "That appointment is already completed and can't be canceled" };
      }
      callEventBus.publishGlobal("appointment.canceled", { appointment: result.appointment });
      return { canceled: true, appointmentId: result.appointment.id };
    },
  };

  return [checkAvailability, scheduleAppointment, cancelAppointmentTool];
}
