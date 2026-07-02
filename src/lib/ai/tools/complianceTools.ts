import { ToolDefinition } from "../types";
import { addToDnc } from "../../compliance/dncService";
import { DncSource } from "@prisma/client";

export interface ComplianceToolContext {
  phoneNumber?: string;
}

/**
 * Lets the AI agent immediately honor a caller's opt-out request during a
 * live call, satisfying the "automatic opt-out processing" requirement
 * without waiting for a human to update the DNC list afterwards.
 */
export function buildComplianceTools(context: ComplianceToolContext): ToolDefinition[] {
  const addToDncTool: ToolDefinition = {
    name: "add_to_dnc",
    description:
      "Add the current caller's phone number to the Do-Not-Call list. Call this immediately whenever the caller asks to stop being contacted, to be removed from the list, or to opt out.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Brief reason the caller gave, if any" },
      },
    },
    handler: async (args) => {
      if (!context.phoneNumber) {
        return { added: false, reason: "No phone number available for this call" };
      }

      await addToDnc(context.phoneNumber, args.reason as string | undefined, DncSource.CALLER_REQUEST);
      return { added: true, phoneNumber: context.phoneNumber };
    },
  };

  return [addToDncTool];
}
