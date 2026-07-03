export type DncSource = "MANUAL" | "CALLER_REQUEST";

export interface DncEntry {
  id: string;
  phoneNumber: string;
  reason: string | null;
  source: DncSource;
  createdAt: string;
}
