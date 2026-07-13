import type { ConversationMessage } from "./conversationMessage";
import type { Appointment } from "./appointment";

export type CallDirection = "INBOUND" | "OUTBOUND";

export type CallStatus =
  | "QUEUED"
  | "INITIATED"
  | "RINGING"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "NO_ANSWER"
  | "BUSY"
  | "CANCELED";

export interface Call {
  id: string;
  telnyxCallControlId: string | null;
  direction: CallDirection;
  status: CallStatus;
  fromNumber: string;
  toNumber: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  outcome: string | null;
  /**
   * Stable in-app link (…/calls/:id/recording) that redirects to a freshly
   * minted Telnyx download URL. Null before a recording is saved, or once it
   * has been deleted after the retention window.
   */
  recordingUrl: string | null;
  leadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallWithDetails extends Call {
  messages: ConversationMessage[];
  appointments: Appointment[];
}
