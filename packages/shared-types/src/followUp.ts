export type FollowUpStatus =
  | "PENDING"
  | "CALLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "SKIPPED_DNC"
  | "SKIPPED_NO_CONSENT";

export interface FollowUp {
  id: string;
  leadId: string;
  callId: string | null;
  reason: string | null;
  scheduledAt: string;
  status: FollowUpStatus;
  createdAt: string;
}
