import { ToolDefinition } from "../types";
import { addToDnc } from "@telephony/domain";
import { DncSource } from "@telephony/database";

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
      "Add the current caller's phone number to the Do-Not-Call list. Call this immediately whenever the caller " +
      "expresses - explicitly or implicitly - that they don't want to be contacted again: a direct request " +
      "('stop calling me', 'take me off your list', 'remove my number'), or an implicit signal with the same " +
      "intent even without those exact words ('just leave me alone', 'I don't want to hear from you again', " +
      "'quit bothering me'). Err on the side of calling this whenever the caller's intent to not be contacted " +
      "again is reasonably clear, even if they don't use a canonical opt-out phrase.",
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
