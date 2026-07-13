import { Job, Worker } from "bullmq";
import { env } from "@telephony/config";
import {
  redisConnection,
  DIAL_QUEUE_NAME,
  DialJobData,
  RECORDING_CLEANUP_QUEUE_NAME,
  RecordingCleanupJobData,
  reconcilePendingWork,
} from "@telephony/queue";
import { processFollowUpJob, processCampaignContactJob, processRecordingDeletion } from "@telephony/domain";

export async function processDialJob(job: Job<DialJobData>): Promise<void> {
  if (job.data.type === "followup") {
    await processFollowUpJob(job.data.followUpId);
  } else {
    await processCampaignContactJob(job.data.campaignContactId);
  }
}

export async function processRecordingCleanupJob(job: Job<RecordingCleanupJobData>): Promise<void> {
  await processRecordingDeletion(job.data.callId);
}

export function startWorker(): Worker<DialJobData, void, string> {
  const worker = new Worker<DialJobData, void, string>(DIAL_QUEUE_NAME, processDialJob, {
    connection: redisConnection,
    limiter: { max: env.DIAL_RATE_LIMIT_MAX, duration: env.DIAL_RATE_LIMIT_DURATION_MS },
  });

  worker.on("failed", (job, error) => {
    // eslint-disable-next-line no-console
    console.error(`Dial job ${job?.id} failed:`, error);
  });

  return worker;
}

export function startRecordingCleanupWorker(): Worker<RecordingCleanupJobData, void, string> {
  const worker = new Worker<RecordingCleanupJobData, void, string>(
    RECORDING_CLEANUP_QUEUE_NAME,
    processRecordingCleanupJob,
    { connection: redisConnection }
  );

  worker.on("failed", (job, error) => {
    // eslint-disable-next-line no-console
    console.error(`Recording cleanup job ${job?.id} failed:`, error);
  });

  return worker;
}

// Only run the standalone-process side effects (start the worker, reconcile
// pending work, log) when this file is executed directly (node dist/worker.js).
// Importing it as a module (e.g. from an e2e test that wants a controlled,
// in-process Worker instance) must not trigger any of this.
if (require.main === module) {
  startWorker();
  startRecordingCleanupWorker();

  reconcilePendingWork()
    .then(({ followUps, campaignContacts }) => {
      // eslint-disable-next-line no-console
      console.log(`Reconciled pending work: ${followUps} follow-up(s), ${campaignContacts} campaign contact(s)`);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Startup reconciliation failed:", error);
    });

  // eslint-disable-next-line no-console
  console.log(`Dial worker started (rate limit: ${env.DIAL_RATE_LIMIT_MAX}/${env.DIAL_RATE_LIMIT_DURATION_MS}ms)`);
  // eslint-disable-next-line no-console
  console.log(`Recording cleanup worker started (retention: ${env.RECORDING_RETENTION_HOURS}h)`);
}
