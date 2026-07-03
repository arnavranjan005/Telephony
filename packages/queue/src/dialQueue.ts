import { Queue } from "bullmq";
import { redisConnection } from "./redis";

export const DIAL_QUEUE_NAME = "dial";

export type DialJobData =
  | { type: "followup"; followUpId: string }
  | { type: "campaign-contact"; campaignContactId: string };

export const dialQueue = new Queue<DialJobData, void, string>(DIAL_QUEUE_NAME, { connection: redisConnection });

/** Deterministic BullMQ job IDs so re-enqueueing the same row is a no-op. */
export function followUpJobId(followUpId: string): string {
  return `followup:${followUpId}`;
}

export function campaignContactJobId(campaignContactId: string): string {
  return `campaign-contact:${campaignContactId}`;
}

export async function enqueueFollowUpDial(followUpId: string, scheduledAt: Date): Promise<void> {
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await dialQueue.add(
    "followup",
    { type: "followup", followUpId },
    { jobId: followUpJobId(followUpId), delay, removeOnComplete: true, removeOnFail: 1000 }
  );
}

export async function enqueueCampaignContactDial(campaignContactId: string): Promise<void> {
  await dialQueue.add(
    "campaign-contact",
    { type: "campaign-contact", campaignContactId },
    { jobId: campaignContactJobId(campaignContactId), removeOnComplete: true, removeOnFail: 1000 }
  );
}
