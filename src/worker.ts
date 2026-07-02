import { Job, Worker } from "bullmq";
import { env } from "./config/env";
import { redisConnection } from "./config/redis";
import { DIAL_QUEUE_NAME, DialJobData } from "./queues/dialQueue";
import { reconcilePendingWork } from "./queues/reconciliation";
import { processFollowUpJob } from "./services/followUpService";
import { processCampaignContactJob } from "./services/campaignService";

async function processDialJob(job: Job<DialJobData>): Promise<void> {
  if (job.data.type === "followup") {
    await processFollowUpJob(job.data.followUpId);
  } else {
    await processCampaignContactJob(job.data.campaignContactId);
  }
}

const worker = new Worker<DialJobData, void, string>(DIAL_QUEUE_NAME, processDialJob, {
  connection: redisConnection,
  limiter: { max: env.DIAL_RATE_LIMIT_MAX, duration: env.DIAL_RATE_LIMIT_DURATION_MS },
});

worker.on("failed", (job, error) => {
  // eslint-disable-next-line no-console
  console.error(`Dial job ${job?.id} failed:`, error);
});

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
