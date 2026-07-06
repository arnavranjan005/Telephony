import type { Lead } from "./lead";

export type CampaignStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
export type CampaignContactStatus = "PENDING" | "CALLING" | "CALLED" | "FAILED" | "SKIPPED_DNC" | "SKIPPED_NO_CONSENT";

export interface Campaign {
  id: string;
  name: string;
  script: string | null;
  objectionPlaybook: string | null;
  status: CampaignStatus;
  fromNumber: string | null;
  streamingEnabled: boolean;
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

export interface CampaignWithContacts extends Campaign {
  contacts: Array<CampaignContact & { lead: Lead }>;
}

export interface CreateCampaignContactInput {
  leadId?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
}

export interface CreateCampaignInput {
  name: string;
  script?: string;
  objectionPlaybook?: string;
  streamingEnabled?: boolean;
  contacts: CreateCampaignContactInput[];
}
