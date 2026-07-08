import { ToolDefinition } from "../types";
import { prisma } from "@telephony/database";

export interface CallControlToolContext {
  callId: string;
}

/**
 * Lets the agent end the call once the conversation has genuinely concluded.
 * Doesn't hang up immediately - just flags intent on the Call row. The
 * model's own farewell line (its reply text for this same turn) is still
 * spoken in full; the actual hangup is triggered afterward, once that speech
 * finishes playing (the call.speak.ended webhook for the non-streaming path,
 * or right after the streaming TTS handle resolves in CallStreamSession) -
 * see callController.ts's "call.speak.ended" case and
 * CallStreamSession.handleTurnEnd.
 */
export function buildCallControlTools(context: CallControlToolContext): ToolDefinition[] {
  const endCallTool: ToolDefinition = {
    name: "end_call",
    description:
      "End the phone call. Call this once the conversation has genuinely concluded - the caller has said " +
      "goodbye, confirms they have nothing else to discuss, or asks to end the call, or you've finished " +
      "wrapping up (e.g. right after booking an appointment and confirming the details, or after processing " +
      "an opt-out request). Say your brief, natural goodbye as your reply once you see this tool's result, " +
      "not in the same turn as the call itself - that reply is what actually gets spoken before the call " +
      "ends. Don't call this while the caller is mid-thought, still asking questions, or the conversation is " +
      "otherwise still active.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      await prisma.call.update({ where: { id: context.callId }, data: { endCallRequested: true } });
      return { acknowledged: true };
    },
  };

  return [endCallTool];
}
