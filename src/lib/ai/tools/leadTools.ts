import { ToolDefinition } from "../types";
import { prisma } from "../../../config/prisma";
import { LeadStatus } from "@prisma/client";

export interface LeadToolContext {
  leadId?: string;
}

/**
 * Tool letting the agent record lead qualification updates (status, notes)
 * as they surface naturally during the conversation.
 */
export function buildLeadTools(context: LeadToolContext): ToolDefinition[] {
  const updateLead: ToolDefinition = {
    name: "update_lead_status",
    description: "Update the lead's qualification status and notes based on what was learned in the call.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["COLD", "WARM", "HOT"], description: "Lead qualification level" },
        notes: { type: "string", description: "Summary of relevant details learned during the call" },
      },
      required: ["status"],
    },
    handler: async (args) => {
      if (!context.leadId) {
        return { updated: false, reason: "No lead associated with this call" };
      }

      const lead = await prisma.lead.update({
        where: { id: context.leadId },
        data: {
          status: args.status as LeadStatus,
          notes: (args.notes as string | undefined) ?? undefined,
        },
      });

      return { updated: true, leadId: lead.id, status: lead.status };
    },
  };

  return [updateLead];
}
