import { prisma } from "../config/prisma";
import { getAIAgent } from "../lib/ai/agentFactory";
import { runConversationTurn } from "../lib/ai/conversationRunner";
import { AgentMessage, AgentRole } from "../lib/ai/types";
import { buildCalendarTools } from "../lib/ai/tools/calendarTools";
import { buildLeadTools } from "../lib/ai/tools/leadTools";
import { buildComplianceTools } from "../lib/ai/tools/complianceTools";
import { buildFollowUpTools } from "../lib/ai/tools/followUpTools";
import { speakText } from "../lib/telnyx/callService";
import { callEventBus } from "../sse/eventBus";
import { CallDirection, MessageRole } from "@prisma/client";

const SYSTEM_PROMPT = `You are a friendly, professional voice sales/support agent speaking on a live phone call.
Keep responses short and conversational (1-3 sentences), as they will be spoken aloud via text-to-speech.
Use the available tools to check calendar availability, book appointments, and update lead status when appropriate.
Never invent appointment times without checking availability first.`;

const ROLE_TO_DB: Record<AgentRole, MessageRole> = {
  user: MessageRole.USER,
  assistant: MessageRole.ASSISTANT,
  system: MessageRole.SYSTEM,
  tool: MessageRole.TOOL,
};

const DB_TO_ROLE: Record<MessageRole, AgentRole> = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
};

async function loadHistory(callId: string): Promise<AgentMessage[]> {
  const rows = await prisma.conversationMessage.findMany({
    where: { callId },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((row) => ({
    role: DB_TO_ROLE[row.role],
    content: row.content,
    toolName: row.toolName ?? undefined,
    toolArgs: (row.toolArgs as Record<string, unknown> | null) ?? undefined,
  }));
}

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
    ...buildFollowUpTools({ leadId: call?.leadId ?? undefined }),
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
