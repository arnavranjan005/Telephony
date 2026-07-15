import { ToolDefinition } from "../types";
import { prisma, LeadStatus } from "@telephony/database";

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

  const getLeadDetails: ToolDefinition = {
    name: "get_lead_details",
    description:
      "Look up the recorded details for this call's lead: the organization/company name on file, its current " +
      "qualification status, and any notes from earlier interactions. The name on file always identifies the " +
      "business/organization you're calling, never the individual answering the phone - that person is an " +
      "employee or representative of the company, not the company itself. Never tell them \"you are " +
      "[company name]\" or otherwise address them as if the company name were their own personal name; instead " +
      "use it to confirm you've reached the right business (e.g. \"Am I speaking with someone from [company " +
      "name]?\") or reference it naturally in conversation. Call this early on if you don't already know which " +
      "company you're speaking with.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!context.leadId) {
        return { found: false, reason: "No lead associated with this call" };
      }

      const lead = await prisma.lead.findUnique({
        where: { id: context.leadId },
        select: { name: true, status: true, notes: true },
      });
      if (!lead) return { found: false, reason: "Lead not found" };

      return { found: true, organizationName: lead.name, status: lead.status, notes: lead.notes };
    },
  };

  const getLeadEmail: ToolDefinition = {
    name: "get_lead_email",
    description:
      "Check whether this lead already has an email address on file (e.g. from signup or an earlier call), before asking " +
      "the caller for one or relying on the conversation transcript. Call this first, before schedule_appointment, whenever " +
      "you don't already have a confirmed email for this booking. If it returns hasEmail: true, read the email back to the " +
      "caller and ask them to confirm it's still correct or give a different one - never assume it's still accurate without " +
      "asking. If it returns hasEmail: false, fall back to checking what the caller has already told you in this " +
      "conversation, or ask them directly.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!context.leadId) {
        return { hasEmail: false, reason: "No lead associated with this call" };
      }

      const lead = await prisma.lead.findUnique({ where: { id: context.leadId }, select: { email: true } });
      return lead?.email ? { hasEmail: true, email: lead.email } : { hasEmail: false };
    },
  };

  return [updateLead, getLeadDetails, getLeadEmail];
}
