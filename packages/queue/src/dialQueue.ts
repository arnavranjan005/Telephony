import { Queue } from "bullmq";
import { redisConnection } from "./redis";

export const DIAL_QUEUE_NAME = "dial";

export type DialJobData =
  | { type: "followup"; followUpId: string }
  | { type: "campaign-contact"; campaignContactId: string };

export const dialQueue = new Queue<DialJobData, void, string>(DIAL_QUEUE_NAME, { connection: redisConnection });

/**
 * Deterministic BullMQ job IDs so re-enqueueing the same row is a no-op.
 * BullMQ reserves `:` in custom job IDs for its own repeatable-job encoding
 * (a bare `foo:bar` custom ID throws "Custom Id cannot contain :" - it only
 * accepts colons in groups of exactly 3 segments), so a plain "-" separator
 * is used instead.
 */
export function followUpJobId(followUpId: string): string {
  return `followup-${followUpId}`;
}

export function campaignContactJobId(campaignContactId: string): string {
  return `campaign-contact-${campaignContactId}`;
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

/**
 * Reschedules a dial for a specific future instant (used to push a job past
 * TCPA calling-hours into its next legal window). Uses a distinct jobId
 * (suffixed by the target instant) rather than the row's deterministic
 * `followup-<id>` job ID: this call happens from *within* that job's own
 * still-active processor, and BullMQ treats an add() with the same jobId as
 * an already-active job as a no-op, which would silently drop the
 * reschedule. A fresh ID is safe because the real dedup guarantee is the
 * atomic PENDING -> CALLING claim in the database, not the BullMQ job ID.
 */
export async function enqueueFollowUpDialAt(followUpId: string, runAt: Date): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  await dialQueue.add(
    "followup",
    { type: "followup", followUpId },
    { jobId: `${followUpJobId(followUpId)}-retry-${runAt.getTime()}`, delay, removeOnComplete: true, removeOnFail: 1000 }
  );
}

/** See enqueueFollowUpDialAt - same rationale, for campaign contacts. */
export async function enqueueCampaignContactDialAt(campaignContactId: string, runAt: Date): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  await dialQueue.add(
    "campaign-contact",
    { type: "campaign-contact", campaignContactId },
    {
      jobId: `${campaignContactJobId(campaignContactId)}-retry-${runAt.getTime()}`,
      delay,
      removeOnComplete: true,
      removeOnFail: 1000,
    }
  );
}

/**
 * Removes any not-yet-started BullMQ job(s) for a follow-up, so canceling it
 * actually unwinds the "this will place a call later" side effect instead of
 * just flipping the DB status and leaving the job to fire and no-op later.
 * Scans for the job by data (not just the deterministic `followup-<id>` id),
 * because a follow-up rescheduled past the TCPA calling-hours window
 * (enqueueFollowUpDialAt) lives under a different, timestamp-suffixed job id
 * that can't be reconstructed from just the follow-up id.
 *
 * Only targets "delayed"/"waiting" jobs - an "active" job (a worker already
 * running processFollowUpJob) is deliberately left alone: its own atomic
 * PENDING-only claim already makes it a safe no-op once the DB row is
 * CANCELED, so removal here is queue hygiene, not a correctness requirement,
 * and BullMQ refuses to remove a locked/active job anyway.
 */
export async function removeFollowUpDialJobs(followUpId: string): Promise<void> {
  const jobs = await dialQueue.getJobs(["delayed", "waiting"]);
  await Promise.all(
    jobs
      .filter((job) => job.data.type === "followup" && job.data.followUpId === followUpId)
      .map((job) => job.remove().catch(() => undefined))
  );
}
