import { FollowUpStatus, prisma } from "@telephony/database";
import { enqueueFollowUpDial, enqueueFollowUpDialAt } from "@telephony/queue";
import { env } from "@telephony/config";
import { placeOutboundCall } from "./outboundDialService";
import { isWithinCallingHours, nextCallingWindowStart } from "./compliance/callingHours";

export interface CreateFollowUpInput {
  leadId: string;
  scheduledAt: Date;
  reason?: string;
  callId?: string;
  /** Opts this callback dial into real-time media streaming (barge-in) - see
   * outboundDialService.ts's PlaceOutboundCallOptions. Still gated by the
   * global MEDIA_STREAM_ENABLED flag at dial time. */
  streamingEnabled?: boolean;
}

export async function createFollowUp(input: CreateFollowUpInput) {
  const followUp = await prisma.followUp.create({ data: input });
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

export async function cancelFollowUp(id: string) {
  return prisma.followUp.update({ where: { id }, data: { status: FollowUpStatus.CANCELED } });
}

/**
 * Processes one follow-up dial job. Atomically claims the row
 * (PENDING -> CALLING via a conditional UPDATE) before dialing, so if two
 * workers race on the same row - or the reconciliation sweep re-enqueues a
 * row something else already claimed - only one of them actually dials.
 * Called by the worker; safe to call multiple times for the same id.
 */
export async function processFollowUpJob(followUpId: string): Promise<void> {
  const claimed = await prisma.followUp.updateMany({
    where: { id: followUpId, status: FollowUpStatus.PENDING },
    data: { status: FollowUpStatus.CALLING },
  });
  if (claimed.count === 0) return; // already claimed, canceled, or completed elsewhere

  const followUp = await prisma.followUp.findUniqueOrThrow({ where: { id: followUpId }, include: { lead: true } });

  // TCPA calling-hours (8am-9pm local to the number) is a *when*, not a
  // *whether* - give the claim back instead of finalizing a terminal status,
  // and reschedule for the next legal window rather than dropping the row.
  if (!isWithinCallingHours(followUp.lead.phoneNumber)) {
    await prisma.followUp.update({ where: { id: followUpId }, data: { status: FollowUpStatus.PENDING } });
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
