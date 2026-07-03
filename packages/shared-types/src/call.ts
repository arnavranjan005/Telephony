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
  recordingUrl: string | null;
  leadId: string | null;
  createdAt: string;
  updatedAt: string;
}
