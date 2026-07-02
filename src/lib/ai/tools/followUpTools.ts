import { ToolDefinition } from "../types";
import { createFollowUp } from "../../../services/followUpService";

export interface FollowUpToolContext {
  leadId?: string;
}

/**
 * Lets the AI agent offer and schedule a callback mid-conversation (e.g. "the
 * decision maker isn't available, call back Thursday afternoon"), following
 * the same bind-to-call-context pattern as the calendar tools.
 */
export function buildFollowUpTools(context: FollowUpToolContext): ToolDefinition[] {
  const scheduleFollowUp: ToolDefinition = {
    name: "schedule_followup",
    description:
      "Schedule an automatic callback to this lead at a future date/time. Use when the caller asks to be called back later, or when a promised follow-up is needed.",
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

      const followUp = await createFollowUp({
        leadId: context.leadId,
        scheduledAt: new Date(args.scheduledAt as string),
        reason: args.reason as string | undefined,
      });

      return { scheduled: true, followUpId: followUp.id, scheduledAt: followUp.scheduledAt };
    },
  };

  return [scheduleFollowUp];
}
