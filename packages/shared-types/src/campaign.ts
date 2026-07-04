export type CampaignStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
export type CampaignContactStatus = "PENDING" | "CALLING" | "CALLED" | "FAILED" | "SKIPPED_DNC" | "SKIPPED_NO_CONSENT";

export interface Campaign {
  id: string;
  name: string;
  script: string | null;
  status: CampaignStatus;
  fromNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignContact {
  id: string;
  campaignId: string;
  leadId: string;
  status: CampaignContactStatus;
  callId: string | null;
  attemptedAt: string | null;
  createdAt: string;
}
