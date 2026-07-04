import { FollowUpStatus, prisma } from "@telephony/database";
import { enqueueFollowUpDial } from "@telephony/queue";
import { placeOutboundCall } from "./outboundDialService";

export interface CreateFollowUpInput {
  leadId: string;
  scheduledAt: Date;
  reason?: string;
  callId?: string;
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
  const result = await placeOutboundCall(followUp.lead.phoneNumber, followUp.leadId);

  if (result.outcome === "skipped_dnc") {
    await prisma.followUp.update({ where: { id: followUpId }, data: { status: FollowUpStatus.SKIPPED_DNC } });
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
