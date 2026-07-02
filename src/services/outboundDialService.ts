import { CallDirection, CallStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { initiateOutboundCall } from "../lib/telnyx/callService";
import { isNumberOnDnc } from "../lib/compliance/dncService";

export type DialResult =
  | { outcome: "dialed"; callId: string }
  | { outcome: "skipped_dnc" }
  | { outcome: "failed"; error: string };

/**
 * Single dialing path shared by the manual outbound-call endpoint, campaign
 * dispatch, and follow-up dispatch: checks the DNC list, creates the Call
 * record, and places the Telnyx call. Keeping this in one place means the
 * DNC check can't be skipped by a future call site that forgets it.
 */
export async function placeOutboundCall(toNumber: string, leadId?: string): Promise<DialResult> {
  if (await isNumberOnDnc(toNumber)) {
    return { outcome: "skipped_dnc" };
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
    await prisma.call.update({ where: { id: call.id }, data: { status: CallStatus.FAILED } });
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
