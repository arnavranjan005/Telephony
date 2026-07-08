import { FollowUp, FollowUpStatus, prisma } from "@telephony/database";
import { enqueueFollowUpDial, enqueueFollowUpDialAt, removeFollowUpDialJobs } from "@telephony/queue";
import { env } from "@telephony/config";
import { placeOutboundCall } from "./outboundDialService";
import { isWithinCallingHours, nextCallingWindowStart } from "./compliance/callingHours";

export interface CreateFollowUpInput {
  leadId: string;
  scheduledAt: Date;
  reason?: string;
  callId?: string;
  /** This callback dials with real-time media streaming (barge-in) by
   * default - see outboundDialService.ts's PlaceOutboundCallOptions. Pass
   * `false` to opt this callback out. Still gated by the global
   * MEDIA_STREAM_ENABLED flag at dial time either way. */
  streamingEnabled?: boolean;
}

export async function createFollowUp(input: CreateFollowUpInput) {
  const followUp = await prisma.followUp.create({
    data: { ...input, streamingEnabled: input.streamingEnabled ?? true },
  });
  await enqueueFollowUpDial(followUp.id, followUp.scheduledAt);
  return followUp;
}

export async function listFollowUps(status?: FollowUpStatus) {
  return prisma.followUp.findMany({
    where: status ? { status } : undefined,
    orderBy: { scheduledAt: "asc" },
    include: { lead: true },
  });
}

export type CancelFollowUpResult =
  | { outcome: "canceled"; followUp: FollowUp }
  | { outcome: "not_cancelable"; followUp: FollowUp }
  | { outcome: "not_found" };

// A function, not a module-level constant - evaluating FollowUpStatus.* at
// import time (rather than lazily, when actually called) would throw in any
// test that imports this module transitively without providing a full
// FollowUpStatus mock, even one that never calls these functions.
function claimableStatuses(): FollowUpStatus[] {
  return [FollowUpStatus.PENDING, FollowUpStatus.WAITING_FOR_CALLING_HOURS];
}

/**
 * Atomically cancels a follow-up: the CANCELED transition only lands via a
 * conditional UPDATE gated on the row still being PENDING or
 * WAITING_FOR_CALLING_HOURS - the same compare-and-swap pattern
 * processFollowUpJob uses to claim a row for dialing - so a cancel racing the
 * worker's own claim can't corrupt either side; exactly one of them wins, and
 * the loser is told so instead of silently overwriting the winner's status.
 * Canceling something already CALLING/COMPLETED/FAILED is reported as
 * not_cancelable rather than blindly forced to CANCELED. Repeating a cancel
 * on an already-CANCELED row is a no-op success, so it's safe to call from an
 * AI tool the model might invoke twice, or a retried client request.
 *
 * Winning the claim also removes the row's pending BullMQ dial job(s), so
 * canceling actually unwinds the "this will place a call later" side effect
 * instead of just flipping a status flag and leaving a dead job to fire and
 * no-op on its own later.
 */
export async function cancelFollowUp(id: string): Promise<CancelFollowUpResult> {
  const claimed = await prisma.followUp.updateMany({
    where: { id, status: { in: claimableStatuses() } },
    data: { status: FollowUpStatus.CANCELED },
  });

  if (claimed.count === 1) {
    await removeFollowUpDialJobs(id);
    return { outcome: "canceled", followUp: await prisma.followUp.findUniqueOrThrow({ where: { id } }) };
  }

  const followUp = await prisma.followUp.findUnique({ where: { id } });
  if (!followUp) return { outcome: "not_found" };
  if (followUp.status === FollowUpStatus.CANCELED) return { outcome: "canceled", followUp };
  return { outcome: "not_cancelable", followUp };
}

/**
 * Finds the most recent still-cancelable (PENDING or
 * WAITING_FOR_CALLING_HOURS) follow-up for a lead, so a caller (e.g. the AI
 * agent's cancel_followup tool) can cancel "the callback we just scheduled"
 * without already knowing its id. Prefers one originating from the current
 * call when given, since that's almost always what's meant mid-conversation;
 * falls back to the lead's most recent cancelable callback from any call
 * otherwise.
 */
export async function findCancelableFollowUpId(params: { leadId: string; callId?: string }): Promise<string | null> {
  if (params.callId) {
    const scoped = await prisma.followUp.findFirst({
      where: { leadId: params.leadId, callId: params.callId, status: { in: claimableStatuses() } },
      orderBy: { createdAt: "desc" },
    });
    if (scoped) return scoped.id;
  }

  const mostRecent = await prisma.followUp.findFirst({
    where: { leadId: params.leadId, status: { in: claimableStatuses() } },
    orderBy: { createdAt: "desc" },
  });
  return mostRecent?.id ?? null;
}

/**
 * Processes one follow-up dial job. Atomically claims the row
 * (PENDING/WAITING_FOR_CALLING_HOURS -> CALLING via a conditional UPDATE)
 * before dialing, so if two workers race on the same row - or the
 * reconciliation sweep re-enqueues a row something else already claimed -
 * only one of them actually dials.
 * Called by the worker; safe to call multiple times for the same id.
 */
export async function processFollowUpJob(followUpId: string): Promise<void> {
  const claimed = await prisma.followUp.updateMany({
    where: { id: followUpId, status: { in: claimableStatuses() } },
    data: { status: FollowUpStatus.CALLING },
  });
  if (claimed.count === 0) return; // already claimed, canceled, or completed elsewhere

  const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId }, include: { lead: true } });

  // TCPA calling-hours (8am-9pm local to the number) is a *when*, not a
  // *whether* - give the claim back instead of finalizing a terminal status,
  // and reschedule for the next legal window rather than dropping the row.
  // Distinct from PENDING so the admin panel can show this follow-up is
  // genuinely waiting on its calling window, not just never attempted.
  if (!isWithinCallingHours(followUp.lead.phoneNumber)) {
    await prisma.followUp.update({
      where: { id: followUpId },
      data: { status: FollowUpStatus.WAITING_FOR_CALLING_HOURS },
    });
    await enqueueFollowUpDialAt(followUpId, nextCallingWindowStart(followUp.lead.phoneNumber));
    return;
  }

  const result = await placeOutboundCall(followUp.lead.phoneNumber, followUp.leadId, {
    requireConsent: true,
    streamingEnabled: Boolean(followUp.streamingEnabled) && env.MEDIA_STREAM_ENABLED,
  });

  if (result.outcome === "skipped_dnc") {
    await prisma.followUp.update({ where: { id: followUpId }, data: { status: FollowUpStatus.SKIPPED_DNC } });
    return;
  }
  if (result.outcome === "skipped_no_consent") {
    await prisma.followUp.update({ where: { id: followUpId }, data: { status: FollowUpStatus.SKIPPED_NO_CONSENT } });
    return;
  }
  if (result.outcome === "failed") {
    await prisma.followUp.update({
      where: { id: followUpId },
      data: { status: FollowUpStatus.FAILED, callId: result.callId },
    });
    return;
  }

  await prisma.followUp.update({ where: { id: followUpId }, data: { callId: result.callId } });
}
