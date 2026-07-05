import { prisma, CallDirection } from "@telephony/database";
import { speakText } from "@telephony/domain";
import { getAIAgent } from "./ai/agentFactory";
import { runConversationTurn } from "./ai/conversationRunner";
import { AgentMessage } from "./ai/types";
import { buildCalendarTools } from "./ai/tools/calendarTools";
import { buildLeadTools } from "./ai/tools/leadTools";
import { buildComplianceTools } from "./ai/tools/complianceTools";
import { buildFollowUpTools } from "./ai/tools/followUpTools";
import { callEventBus } from "./sse/eventBus";
import { ROLE_TO_DB, loadHistory } from "./conversationHistory";

export const SYSTEM_PROMPT = `You are a friendly, professional voice sales/support agent speaking on a live phone call.
Keep responses short and conversational (1-3 sentences), as they will be spoken aloud via text-to-speech.
Use the available tools to check calendar availability, book appointments, and update lead status when appropriate.
Never invent appointment times without checking availability first.
If the caller changes their mind about something you already acted on (e.g. they ask for a different
time after you've already booked an appointment), check whether you need to cancel or adjust that
earlier action using the appropriate tool before completing the new request - don't leave conflicting
actions in place.`;

async function persistNewMessages(callId: string, before: number, all: AgentMessage[]) {
  const newMessages = all.slice(before);
  if (newMessages.length === 0) return;

  await prisma.conversationMessage.createMany({
    data: newMessages.map((message) => ({
      callId,
      role: ROLE_TO_DB[message.role],
      content: message.content,
      toolName: message.toolName,
      toolArgs: message.toolArgs as never,
    })),
  });

  for (const message of newMessages) {
    callEventBus.publish(callId, "conversation.message", message);
  }
}

/**
 * Handles a single caller utterance: persists it, runs the AI agent (with
 * calendar/lead tools) until it produces a final spoken reply, persists the
 * resulting turns, and speaks the reply back on the live call.
 */
export async function handleCallerUtterance(
  callControlId: string,
  callId: string,
  transcript: string
): Promise<string> {
  const call = await prisma.call.findUnique({ where: { id: callId }, include: { campaignContact: { include: { campaign: true } } } });
  const history = await loadHistory(callId);
  const beforeCount = history.length;

  history.push({ role: "user", content: transcript });

  const callerPhoneNumber = call?.direction === CallDirection.INBOUND ? call.fromNumber : call?.toNumber;

  const agent = getAIAgent();
  const tools = [
    ...buildCalendarTools({ leadId: call?.leadId ?? undefined, callId }),
    ...buildLeadTools({ leadId: call?.leadId ?? undefined }),
    ...buildComplianceTools({ phoneNumber: callerPhoneNumber }),
    ...buildFollowUpTools({ leadId: call?.leadId ?? undefined, phoneNumber: callerPhoneNumber }),
  ];

  const campaignScript = call?.campaignContact?.campaign.script;
  const systemPrompt = campaignScript ? `${SYSTEM_PROMPT}\n\nCampaign script/guidance:\n${campaignScript}` : SYSTEM_PROMPT;

  const { history: updatedHistory, finalReply } = await runConversationTurn(agent, history, tools, systemPrompt);

  await persistNewMessages(callId, beforeCount, updatedHistory);

  if (finalReply) {
    await speakText(callControlId, finalReply);
  }

  return finalReply;
}
