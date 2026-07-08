import { CampaignContactStatus, CampaignStatus, FollowUpStatus, prisma } from "@telephony/database";
import { enqueueCampaignContactDial, enqueueFollowUpDial } from "./dialQueue";

/**
 * Re-enqueues every DB row that's still PENDING or WAITING_FOR_CALLING_HOURS
 * but might not have a corresponding BullMQ job (e.g. Redis was
 * flushed/evicted on a free-tier plan, or rows were created while no worker
 * was running). Safe to call repeatedly - enqueueing uses deterministic job
 * IDs, so this is a no-op for rows that already have a live job. A
 * WAITING_FOR_CALLING_HOURS row's own delayed retry job lives under a
 * different, timestamp-suffixed ID (see dialQueue.ts), so this re-enqueues it
 * under the plain deterministic ID instead - harmless duplication (the actual
 * dedup guarantee is the atomic status claim in processFollowUpJob/
 * processCampaignContactJob, not the job ID), and the only way such a row
 * gets swept back in if its original delayed job was lost. Run once on
 * worker startup.
 */
export async function reconcilePendingWork(): Promise<{ followUps: number; campaignContacts: number }> {
  const pendingFollowUps = await prisma.followUp.findMany({
    where: { status: { in: [FollowUpStatus.PENDING, FollowUpStatus.WAITING_FOR_CALLING_HOURS] } },
    select: { id: true, scheduledAt: true },
  });
  await Promise.all(pendingFollowUps.map((f) => enqueueFollowUpDial(f.id, f.scheduledAt)));

  const pendingContacts = await prisma.campaignContact.findMany({
    where: {
      status: { in: [CampaignContactStatus.PENDING, CampaignContactStatus.WAITING_FOR_CALLING_HOURS] },
      campaign: { status: CampaignStatus.RUNNING },
    },
    select: { id: true },
  });
  await Promise.all(pendingContacts.map((c) => enqueueCampaignContactDial(c.id)));

  return { followUps: pendingFollowUps.length, campaignContacts: pendingContacts.length };
}
