import { prisma, CallDirection } from "@telephony/database";
import { speakText } from "@telephony/domain";
import { getAIAgent } from "./ai/agentFactory";
import { runConversationTurn } from "./ai/conversationRunner";
import { AgentMessage } from "./ai/types";
import { buildCalendarTools } from "./ai/tools/calendarTools";
import { buildLeadTools } from "./ai/tools/leadTools";
import { buildComplianceTools } from "./ai/tools/complianceTools";
import { buildFollowUpTools } from "./ai/tools/followUpTools";
import { buildSentimentTools } from "./ai/tools/sentimentTools";
import { callEventBus } from "./sse/eventBus";
import { ROLE_TO_DB, loadHistory } from "./conversationHistory";

/**
 * The baseline objection-handling behavior every call gets by default, with
 * no per-campaign authoring required. Exported on its own (in addition to
 * being folded into SYSTEM_PROMPT below) so the admin panel can show it to
 * whoever is writing a campaign's optional `objectionPlaybook` - so they can
 * see what's already covered and only add campaign-specific detail on top,
 * via GET /api/campaigns/objection-baseline (campaignController.ts).
 */
export const OBJECTION_HANDLING_BASELINE = `When the caller raises a concern or objection (price, timing, trust, "not interested," etc.),
acknowledge it briefly and address it honestly - never invent pricing, features, or guarantees you
don't actually have; offer to have someone follow up rather than guessing. Before deciding how hard to
push back, weigh it against the caller's most recently recorded sentiment: if it's neutral or only
mildly negative, a genuine rebuttal is appropriate; if it's very_negative, drop the rebuttal entirely -
just acknowledge their frustration and offer to wrap up the call gracefully or follow up later instead.`;

/**
 * Verbal-filler guidance ("um," "uh") for a more human-sounding voice. These
 * are literal words the LLM writes into its own reply - unlike SSML pause
 * tags, they belong in the reply text itself since they're genuinely part of
 * what's spoken, so it's fine for them to also appear as-is in the
 * persisted transcript and live UI (ConversationMessage.content), unlike a
 * markup tag that would look broken there. Exported separately (also folded
 * into SYSTEM_PROMPT below) so it can be referenced/tested on its own.
 */
export const VERBAL_FILLER_GUIDANCE = `Speak the way a real person does on a call, not like a written script - it's fine to
include the occasional natural filler ("um," "uh," "you know") or a brief self-correction where one would
genuinely occur, rather than delivering every line as a polished, complete sentence. Don't overdo it - one
per reply at most, and skip fillers entirely when stating something the caller needs to get right the
first time (appointment times, phone numbers, prices), since clarity matters more than realism there.`;

export const SYSTEM_PROMPT = `You are a friendly, professional voice sales/support agent speaking on a live phone call.
Keep responses short and conversational (1-3 sentences), as they will be spoken aloud via text-to-speech.
Use the available tools to check calendar availability, book appointments, and update lead status when appropriate.
Never invent appointment times without checking availability first.
If the caller changes their mind about something you already acted on (e.g. they ask for a different
time after you've already booked an appointment or scheduled a callback), cancel the earlier action
first with cancel_appointment or cancel_followup before completing the new request with
schedule_appointment or schedule_followup - don't leave conflicting actions in place.
Whenever you notice a shift in the caller's tone or mood (e.g. growing frustrated, upset, or notably
pleased), call record_sentiment to note it - every time it changes, not just once - and let it guide
how you say your next line.
${OBJECTION_HANDLING_BASELINE}
${VERBAL_FILLER_GUIDANCE}`;

interface CampaignPromptSource {
  script?: string | null;
  objectionPlaybook?: string | null;
}

/**
 * Layers a campaign's optional script/objection-playbook text on top of the
 * shared SYSTEM_PROMPT. Both fields are opt-in - a campaign with neither set
 * falls back to the baseline instructions (including the generic objection
 * handling above) with no per-campaign authoring required.
 */
export function buildSystemPrompt(campaign?: CampaignPromptSource | null): string {
  const parts = [SYSTEM_PROMPT];
  if (campaign?.script) parts.push(`Campaign script/guidance:\n${campaign.script}`);
  if (campaign?.objectionPlaybook) parts.push(`Campaign objection playbook:\n${campaign.objectionPlaybook}`);
  return parts.join("\n\n");
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
    ...buildFollowUpTools({
      leadId: call?.leadId ?? undefined,
      phoneNumber: callerPhoneNumber,
      callId,
      streamingEnabled: call?.streamingEnabled,
    }),
    ...buildSentimentTools(),
  ];

  const systemPrompt = buildSystemPrompt(call?.campaignContact?.campaign);

  const { history: updatedHistory, finalReply } = await runConversationTurn(agent, history, tools, systemPrompt);

  await persistNewMessages(callId, beforeCount, updatedHistory);

  if (finalReply) {
    await speakText(callControlId, finalReply);
  }

  return finalReply;
}
