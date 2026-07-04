import { CallDirection, CallStatus, CampaignContactStatus, FollowUpStatus, prisma } from "@telephony/database";
import { initiateOutboundCall } from "./telnyx/callService";
import { isNumberOnDnc } from "./dncService";
import { hasConsent } from "./consentService";

export type DialResult =
  | { outcome: "dialed"; callId: string }
  | { outcome: "skipped_dnc" }
  | { outcome: "skipped_no_consent" }
  | { outcome: "failed"; error: string; callId: string };

export interface PlaceOutboundCallOptions {
  /**
   * Require the lead to have on-file TCPA consent (Lead.consentStatus ===
   * GRANTED) before dialing. Set by automated campaign/follow-up dispatch,
   * where a human isn't reviewing each call before it's placed; left off for
   * the manual single-call endpoint, which a human explicitly triggers.
   */
  requireConsent?: boolean;
}

/**
 * Single dialing path shared by the manual outbound-call endpoint, campaign
 * dispatch, and follow-up dispatch: checks the DNC list (and, for automated
 * dispatch, consent), creates the Call record, and places the Telnyx call.
 * Keeping this in one place means those checks can't be skipped by a future
 * call site that forgets them.
 */
export async function placeOutboundCall(
  toNumber: string,
  leadId?: string,
  options?: PlaceOutboundCallOptions
): Promise<DialResult> {
  if (await isNumberOnDnc(toNumber)) {
    return { outcome: "skipped_dnc" };
  }

  if (options?.requireConsent && !(leadId && (await hasConsent(leadId)))) {
    return { outcome: "skipped_no_consent" };
  }

  const call = await prisma.call.create({
    data: {
      direction: CallDirection.OUTBOUND,
      status: CallStatus.QUEUED,
      fromNumber: process.env.TELNYX_FROM_NUMBER ?? "",
      toNumber,
      leadId,
    },
  });

  try {
    const telnyxCall = await initiateOutboundCall(toNumber, { callId: call.id });
    if (!telnyxCall.call_control_id) {
      throw new Error("Telnyx did not return a call_control_id");
    }

    await prisma.call.update({
      where: { id: call.id },
      data: { telnyxCallControlId: telnyxCall.call_control_id, status: CallStatus.INITIATED },
    });

    return { outcome: "dialed", callId: call.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.FAILED, outcome: message } });
    return { outcome: "failed", error: message, callId: call.id };
  }
}

/**
 * Finalizes whatever follow-up/campaign-contact originated a call once that
 * call actually ends (i.e. once callController's call.hangup handler has
 * resolved a terminal CallStatus). Without this, a successfully-placed dial
 * leaves its FollowUp/CampaignContact stuck at CALLING forever - dialing
 * only ever claims the row and hands off to Telnyx, nothing downstream ever
 * looked at how the call actually went.
 *
 * Both tables collapse every non-COMPLETED outcome (BUSY, NO_ANSWER,
 * CANCELED, FAILED) to FAILED - neither FollowUpStatus nor
 * CampaignContactStatus has a busy/no-answer-specific value today, so the
 * finer distinction stays on the Call row itself (status/outcome) rather
 * than being lost.
 *
 * Only matches rows still CALLING, so a redelivered call.hangup webhook
 * (Telnyx does retry) is a safe no-op on the second delivery.
 */
export async function finalizeDialOutcome(callId: string, callStatus: CallStatus): Promise<void> {
  const isSuccess = callStatus === CallStatus.COMPLETED;

  await prisma.followUp.updateMany({
    where: { callId, status: FollowUpStatus.CALLING },
    data: { status: isSuccess ? FollowUpStatus.COMPLETED : FollowUpStatus.FAILED },
  });

  const campaignContact = await prisma.campaignContact.findUnique({ where: { callId } });
  if (campaignContact?.status === CampaignContactStatus.CALLING) {
    await prisma.campaignContact.update({
      where: { id: campaignContact.id },
      data: { status: isSuccess ? CampaignContactStatus.CALLED : CampaignContactStatus.FAILED },
    });
  }
}
