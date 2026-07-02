import { CampaignContactStatus, CampaignStatus, FollowUpStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { enqueueCampaignContactDial, enqueueFollowUpDial } from "./dialQueue";

/**
 * Re-enqueues every DB row that's still PENDING but might not have a
 * corresponding BullMQ job (e.g. Redis was flushed/evicted on a free-tier
 * plan, or rows were created while no worker was running). Safe to call
 * repeatedly - enqueueing uses deterministic job IDs, so this is a no-op for
 * rows that already have a live job. Run once on worker startup.
 */
export async function reconcilePendingWork(): Promise<{ followUps: number; campaignContacts: number }> {
  const pendingFollowUps = await prisma.followUp.findMany({
    where: { status: FollowUpStatus.PENDING },
    select: { id: true, scheduledAt: true },
  });
  await Promise.all(pendingFollowUps.map((f) => enqueueFollowUpDial(f.id, f.scheduledAt)));

  const pendingContacts = await prisma.campaignContact.findMany({
    where: { status: CampaignContactStatus.PENDING, campaign: { status: CampaignStatus.RUNNING } },
    select: { id: true },
  });
  await Promise.all(pendingContacts.map((c) => enqueueCampaignContactDial(c.id)));

  return { followUps: pendingFollowUps.length, campaignContacts: pendingContacts.length };
}
