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
import { buildCallControlTools } from "./ai/tools/callControlTools";
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
After schedule_appointment or schedule_followup succeeds, always restate the specific date and time you
just booked back to the caller in your reply, not just a generic acknowledgement - they need to hear it
back to catch any mistake. Only describe actions and outcomes a tool result actually confirms - never claim
to have sent a confirmation email/text or taken any other action that no tool call actually performed.
If the caller changes their mind about something you already acted on (e.g. they ask for a different
time after you've already booked an appointment or scheduled a callback), cancel the earlier action
first with cancel_appointment or cancel_followup before completing the new request with
schedule_appointment or schedule_followup - don't leave conflicting actions in place.
Whenever you notice a shift in the caller's tone or mood (e.g. growing frustrated, upset, or notably
pleased), call record_sentiment to note it - every time it changes, not just once - and let it guide
how you say your next line.
Once the conversation has genuinely concluded - the caller says goodbye, confirms they have nothing else
to discuss, or asks to end the call, or you've just finished wrapping up (e.g. right after booking an
appointment and confirming it back to them) - call end_call, then say your brief, natural goodbye as your
reply once you see the tool result (the same pattern as schedule_appointment/schedule_followup above: the
tool call comes first, your spoken line confirming it comes after). Don't just stop replying and leave the
call sitting open, and don't call end_call while the caller is still mid-thought or the conversation is
otherwise active.
${OBJECTION_HANDLING_BASELINE}
${VERBAL_FILLER_GUIDANCE}`;

interface CampaignPromptSource {
  script?: string | null;
  objectionPlaybook?: string | null;
}

/**
 * Without this, nothing tells the model which side placed the call, and it
 * defaults to the far more common "outbound telemarketer" framing it's seen
 * in training data - introducing itself as calling from some invented
 * company even when a caller dialed in. Explicit per-direction framing so it
 * never has to guess.
 */
function callDirectionGuidance(direction?: CallDirection): string | null {
  if (direction === CallDirection.INBOUND) {
    return "This caller dialed in to reach you - you did not call them. Don't say \"I'm calling from...\" or claim to have initiated the call; instead find out why they called and help with that.";
  }
  if (direction === CallDirection.OUTBOUND) {
    return "You initiated this call to the person on the other end - introduce yourself and the reason for calling.";
  }
  return null;
}

/**
 * The model has no innate sense of "now" - without this, it resolves
 * relative dates the caller mentions ("tomorrow", "next Monday") by guessing
 * off training data or a tool parameter's example value instead of the real
 * current date, producing schedule_followup/schedule_appointment calls with
 * dates that are nonsense (e.g. in the past). Computed fresh per call/turn,
 * not baked into the static SYSTEM_PROMPT, so it's always actually current.
 */
function currentDateTimeGuidance(): string {
  return `The current date and time is ${new Date().toISOString()} (UTC). Use this as the reference point for resolving any relative date/time the caller mentions (e.g. "tomorrow", "next Monday", "in an hour") - never infer today's date from a tool parameter's example value or from your own training data.`;
}

/**
 * Layers a campaign's optional script/objection-playbook text on top of the
 * shared SYSTEM_PROMPT. Both fields are opt-in - a campaign with neither set
 * falls back to the baseline instructions (including the generic objection
 * handling above) with no per-campaign authoring required.
 */
export function buildSystemPrompt(campaign?: CampaignPromptSource | null, direction?: CallDirection): string {
  const parts = [SYSTEM_PROMPT, currentDateTimeGuidance()];
  const directionGuidance = callDirectionGuidance(direction);
  if (directionGuidance) parts.push(directionGuidance);
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
      thoughtSignature: message.thoughtSignature,
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

  // The caller spoke again, so any earlier end_call intent is stale - clear
  // it so a pending call.speak.ended hangup check doesn't fire off the back
  // of this new exchange's reply.
  await prisma.call.updateMany({
    where: { id: callId, endCallRequested: true },
    data: { endCallRequested: false },
  });

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
    ...buildCallControlTools({ callId }),
  ];

  const systemPrompt = buildSystemPrompt(call?.campaignContact?.campaign, call?.direction);

  const { history: updatedHistory, finalReply } = await runConversationTurn(agent, history, tools, systemPrompt);

  await persistNewMessages(callId, beforeCount, updatedHistory);

  if (finalReply) {
    await speakText(callControlId, finalReply);
  }

  return finalReply;
}
