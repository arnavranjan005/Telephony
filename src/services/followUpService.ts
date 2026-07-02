import { FollowUpStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { placeOutboundCall } from "./outboundDialService";

const DEFAULT_DISPATCH_LIMIT = 5;

export interface CreateFollowUpInput {
  leadId: string;
  scheduledAt: Date;
  reason?: string;
  callId?: string;
}

export async function createFollowUp(input: CreateFollowUpInput) {
  return prisma.followUp.create({ data: input });
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
 * Dials every follow-up whose scheduledAt has passed, capped at `limit` per
 * call to avoid bursting Telnyx. Intended to be invoked periodically by the
 * scheduler service.
 */
export async function dispatchDueFollowUps(limit: number = DEFAULT_DISPATCH_LIMIT): Promise<number> {
  const due = await prisma.followUp.findMany({
    where: { status: FollowUpStatus.PENDING, scheduledAt: { lte: new Date() } },
    take: limit,
    include: { lead: true },
  });

  let dispatched = 0;
  for (const followUp of due) {
    const result = await placeOutboundCall(followUp.lead.phoneNumber, followUp.leadId);

    if (result.outcome === "skipped_dnc") {
      await prisma.followUp.update({ where: { id: followUp.id }, data: { status: FollowUpStatus.SKIPPED_DNC } });
      continue;
    }
    if (result.outcome === "failed") {
      await prisma.followUp.update({ where: { id: followUp.id }, data: { status: FollowUpStatus.FAILED } });
      continue;
    }

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { status: FollowUpStatus.CALLING, callId: result.callId },
    });
    dispatched += 1;
  }

  return dispatched;
}
