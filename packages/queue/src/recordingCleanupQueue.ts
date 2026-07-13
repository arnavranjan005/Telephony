import { Queue } from "bullmq";
import { redisConnection } from "./redis";

export const RECORDING_CLEANUP_QUEUE_NAME = "recording-cleanup";

export type RecordingCleanupJobData = { callId: string };

export const recordingCleanupQueue = new Queue<RecordingCleanupJobData, void, string>(
  RECORDING_CLEANUP_QUEUE_NAME,
  { connection: redisConnection }
);

/** Deterministic job id so re-enqueuing the same call is a no-op (see dialQueue.ts). */
export function recordingDeletionJobId(callId: string): string {
  return `recording-delete-${callId}`;
}

/**
 * Schedules a call's recording to be deleted from Telnyx after `retentionHours`
 * (the RECORDING_RETENTION_HOURS window). BullMQ holds the job as "delayed"
 * until then, so this survives process restarts. The deterministic job id means
 * a duplicate call.recording.saved webhook won't stack a second deletion.
 */
export async function enqueueRecordingDeletion(callId: string, retentionHours: number): Promise<void> {
  const delay = Math.max(0, retentionHours * 60 * 60 * 1000);
  await recordingCleanupQueue.add(
    "recording-delete",
    { callId },
    { jobId: recordingDeletionJobId(callId), delay, removeOnComplete: true, removeOnFail: 1000 }
  );
}
