import { ToolDefinition } from "../types";
import {
  cancelFollowUp,
  createFollowUp,
  findCancelableFollowUpId,
  isWithinCallingHours,
  nextCallingWindowStart,
} from "@telephony/domain";

export interface FollowUpToolContext {
  leadId?: string;
  phoneNumber?: string;
  /** The current call's id, used to prefer canceling a callback that
   * originated from this same call when no explicit followUpId is given. */
  callId?: string;
  /** Whether the *current* call is a streaming (barge-in capable) call -
   * inherited onto the scheduled callback so a follow-up promised mid a
   * streaming conversation is itself dialed in streaming mode later (the
   * default either way), without requiring the caller (or the agent) to make
   * an explicit choice. Still gated by the global MEDIA_STREAM_ENABLED flag
   * at actual dial time. */
  streamingEnabled?: boolean;
}

/**
 * Lets the AI agent offer and schedule a callback mid-conversation (e.g. "the
 * decision maker isn't available, call back Thursday afternoon"), following
 * the same bind-to-call-context pattern as the calendar tools.
 *
 * Validates the requested time against the TCPA calling-hours window
 * (8am-9pm local to the caller's number) *before* writing anything - a
 * request outside the window schedules nothing and instead hands the agent a
 * suggested in-window time, so it can negotiate with the caller in the
 * conversation ("I can only call between 8am and 9pm - does 8:30am tomorrow
 * work instead?") rather than silently booking a promise the dial-time
 * calling-hours gate would later break without telling anyone.
 */
export function buildFollowUpTools(context: FollowUpToolContext): ToolDefinition[] {
  const scheduleFollowUp: ToolDefinition = {
    name: "schedule_followup",
    description:
      "Schedule an automatic callback to this lead at a future date/time. Use when the caller asks to be called back later, or when a promised follow-up is needed. " +
      "If the requested time falls outside the legal calling window (8am-9pm local to the caller's number), this will NOT schedule anything - it returns " +
      "scheduled: false with a suggestedTime instead. Tell the caller the suggested time and ask if it works, then call this tool again once they confirm a time. " +
      "If the caller already has a callback scheduled and wants a different time instead, call cancel_followup first.",
    parameters: {
      type: "object",
      properties: {
        scheduledAt: { type: "string", description: "ISO 8601 datetime for the callback, e.g. 2025-01-16T18:00:00Z" },
        reason: { type: "string", description: "Brief reason for the follow-up" },
      },
      required: ["scheduledAt"],
    },
    handler: async (args) => {
      if (!context.leadId) {
        return { scheduled: false, reason: "No lead associated with this call" };
      }

      const scheduledAt = new Date(args.scheduledAt as string);

      // isWithinCallingHours below only validates time-of-day legality, not
      // date sanity - a stale/hallucinated past date could otherwise slip
      // through if its time-of-day happened to land in the legal window.
      if (scheduledAt.getTime() <= Date.now()) {
        return { scheduled: false, reason: "Requested time is in the past" };
      }

      if (context.phoneNumber && !isWithinCallingHours(context.phoneNumber, scheduledAt)) {
        return {
          scheduled: false,
          reason: "Requested time is outside the legal calling window (8am-9pm local to this number)",
          suggestedTime: nextCallingWindowStart(context.phoneNumber, scheduledAt).toISOString(),
        };
      }

      const followUp = await createFollowUp({
        leadId: context.leadId,
        scheduledAt,
        reason: args.reason as string | undefined,
        streamingEnabled: context.streamingEnabled,
      });

      return { scheduled: true, followUpId: followUp.id, scheduledAt: followUp.scheduledAt };
    },
  };

  const cancelFollowUpTool: ToolDefinition = {
    name: "cancel_followup",
    description:
      "Cancel a previously scheduled callback for this lead - e.g. the caller no longer wants to be called back, or wants a different time. " +
      "Call this BEFORE scheduling a replacement with schedule_followup. If you already know the followUpId from an earlier schedule_followup " +
      "result in this conversation, pass it; otherwise the most recent pending callback for this lead will be canceled.",
    parameters: {
      type: "object",
      properties: {
        followUpId: { type: "string", description: "The follow-up id to cancel, if already known" },
      },
    },
    handler: async (args) => {
      if (!context.leadId) {
        return { canceled: false, reason: "No lead associated with this call" };
      }

      const followUpId =
        (args.followUpId as string | undefined) ??
        (await findCancelableFollowUpId({ leadId: context.leadId, callId: context.callId }));

      if (!followUpId) {
        return { canceled: false, reason: "No pending callback found for this lead" };
      }

      const result = await cancelFollowUp(followUpId);
      if (result.outcome === "not_found") {
        return { canceled: false, reason: "Follow-up not found" };
      }
      if (result.outcome === "not_cancelable") {
        return { canceled: false, reason: "That callback is already in progress or resolved and can't be canceled" };
      }
      return { canceled: true, followUpId: result.followUp.id };
    },
  };

  return [scheduleFollowUp, cancelFollowUpTool];
}
