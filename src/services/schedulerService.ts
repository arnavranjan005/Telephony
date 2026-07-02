import { dispatchDueFollowUps } from "./followUpService";
import { dispatchNextCampaignContacts } from "./campaignService";

const DEFAULT_INTERVAL_MS = 30_000;
const PER_TICK_DIAL_CAP = 5;

let isTicking = false;

async function tick(): Promise<void> {
  if (isTicking) return; // previous tick still running - skip to avoid overlapping dispatch
  isTicking = true;
  try {
    await dispatchDueFollowUps(PER_TICK_DIAL_CAP);
    await dispatchNextCampaignContacts(PER_TICK_DIAL_CAP);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Scheduler tick failed:", error);
  } finally {
    isTicking = false;
  }
}

/**
 * Starts the in-process poller that drives campaign and follow-up dialing.
 * No external job queue is used to keep this self-hosted and dependency-free
 * - if this ever needs to run across multiple instances, swap the interval
 * loop for a real queue without touching dispatchDueFollowUps/
 * dispatchNextCampaignContacts.
 */
export function startScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  return setInterval(() => {
    void tick();
  }, intervalMs);
}
