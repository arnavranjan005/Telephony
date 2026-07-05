import { Appointment, AppointmentStatus, prisma } from "@telephony/database";
import { cancelAppointment as cancelGoogleEvent } from "./google-calendar/calendarService";

const CANCELABLE_STATUSES: AppointmentStatus[] = [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED];

export type CancelAppointmentResult =
  | { outcome: "canceled"; appointment: Appointment }
  | { outcome: "not_cancelable"; appointment: Appointment }
  | { outcome: "not_found" };

/**
 * Atomically cancels an appointment: the CANCELED transition only lands via
 * a conditional UPDATE gated on the row still being SCHEDULED/CONFIRMED, so
 * two concurrent cancel attempts (a human via REST and the AI agent
 * mid-call, or a barge-in-triggered retry) can't both win and both try to
 * delete the same Google event. Only the caller that wins the claim touches
 * Google; if that call fails, the claim is reverted to its prior status so
 * the appointment isn't left marked canceled while still live on the real
 * calendar, and a retry can attempt the Google call again cleanly. Repeating
 * a cancel on an already-CANCELED appointment is a no-op success.
 */
export async function cancelAppointmentById(appointmentId: string): Promise<CancelAppointmentResult> {
  const before = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!before) return { outcome: "not_found" };
  if (before.status === AppointmentStatus.CANCELED) {
    return { outcome: "canceled", appointment: before };
  }
  if (!CANCELABLE_STATUSES.includes(before.status)) {
    return { outcome: "not_cancelable", appointment: before };
  }

  const claimed = await prisma.appointment.updateMany({
    where: { id: appointmentId, status: { in: CANCELABLE_STATUSES } },
    data: { status: AppointmentStatus.CANCELED },
  });

  if (claimed.count === 0) {
    // Lost the race: someone else changed the status between the read above
    // and this claim attempt.
    const current = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    return current.status === AppointmentStatus.CANCELED
      ? { outcome: "canceled", appointment: current }
      : { outcome: "not_cancelable", appointment: current };
  }

  if (before.googleEventId) {
    try {
      await cancelGoogleEvent(before.googleEventId);
    } catch (error) {
      await prisma.appointment.update({ where: { id: appointmentId }, data: { status: before.status } });
      throw error;
    }
  }

  return {
    outcome: "canceled",
    appointment: await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
  };
}

/**
 * Finds the most recent still-cancelable appointment for a lead, so a
 * caller (e.g. the AI agent's cancel_appointment tool) can cancel "the
 * appointment we just booked" without already knowing its id. Prefers one
 * linked to the current call when given, since that's almost always what's
 * meant mid-conversation; falls back to the lead's most recent cancelable
 * appointment from any call otherwise.
 */
export async function findCancelableAppointmentId(params: { leadId: string; callId?: string }): Promise<string | null> {
  if (params.callId) {
    const scoped = await prisma.appointment.findFirst({
      where: { leadId: params.leadId, callId: params.callId, status: { in: CANCELABLE_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    if (scoped) return scoped.id;
  }

  const mostRecent = await prisma.appointment.findFirst({
    where: { leadId: params.leadId, status: { in: CANCELABLE_STATUSES } },
    orderBy: { createdAt: "desc" },
  });
  return mostRecent?.id ?? null;
}
