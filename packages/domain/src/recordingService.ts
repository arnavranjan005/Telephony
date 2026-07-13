import { prisma } from "@telephony/database";
import { deleteRecordingsForSession } from "./telnyx/callService";

/**
 * Enforces the recording retention window: deletes a call's recording(s) from
 * Telnyx and drops our references to them. Run from a delayed BullMQ job
 * scheduled RECORDING_RETENTION_HOURS after the recording was saved (see
 * packages/queue/recordingCleanupQueue.ts and apps/worker).
 *
 * Safe to run more than once for the same call: if the recording is already
 * gone (or was never captured), the Telnyx delete is a no-op and clearing the
 * columns is idempotent. `recordingUrl` is nulled alongside the session id so
 * the UI/API stop advertising a link that would now 404.
 */
export async function processRecordingDeletion(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, telnyxCallSessionId: true },
  });
  if (!call?.telnyxCallSessionId) return;

  await deleteRecordingsForSession(call.telnyxCallSessionId);

  await prisma.call.update({
    where: { id: call.id },
    data: { telnyxCallSessionId: null, recordingUrl: null },
  });
}
