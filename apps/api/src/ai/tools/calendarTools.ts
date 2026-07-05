import { ToolDefinition } from "../types";
import { createAppointment, isSlotAvailable } from "../../google-calendar/calendarService";
import { cancelAppointmentById, findCancelableAppointmentId } from "../../appointmentService";
import { prisma } from "@telephony/database";
import { callEventBus } from "../../sse/eventBus";

export interface CalendarToolContext {
  leadId?: string;
  callId?: string;
}

/**
 * Builds the calendar-related tool definitions the AI agent can call during a
 * conversation. Bound to a specific call/lead so bookings made mid-call are
 * automatically linked back to the right records.
 */
export function buildCalendarTools(context: CalendarToolContext): ToolDefinition[] {
  const checkAvailability: ToolDefinition = {
    name: "check_appointment_availability",
    description: "Check whether a proposed appointment time slot is free on the calendar before booking it.",
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
      "If the caller already has an appointment booked and wants a different time instead, call cancel_appointment first.",
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

      const available = await isSlotAvailable(startTime, endTime);
      if (!available) {
        return { booked: false, reason: "Slot is no longer available" };
      }

      const event = await createAppointment({
        summary: args.title as string,
        startTime,
        endTime,
        attendeeEmail: args.attendeeEmail as string | undefined,
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
