import type { Lead } from "./lead";

export type CampaignStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
export type CampaignContactStatus =
  | "PENDING"
  | "WAITING_FOR_CALLING_HOURS"
  | "CALLING"
  | "CALLED"
  | "FAILED"
  | "SKIPPED_DNC"
  | "SKIPPED_NO_CONSENT";

export interface Campaign {
  id: string;
  name: string;
  script: string | null;
  objectionPlaybook: string | null;
  openingLine: string | null;
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
  name?: string;
}

export interface CreateCampaignInput {
  name: string;
  script: string;
  objectionPlaybook?: string;
  openingLine?: string;
  streamingEnabled?: boolean;
  contacts: CreateCampaignContactInput[];
  /** Grants TCPA consent to every lead in the campaign at create time, so
   * contacts added by CSV/number aren't skipped as un-consented when dialing. */
  consentGrantedAll?: boolean;
}

export interface AddCampaignContactsInput {
  contacts: CreateCampaignContactInput[];
  consentGrantedAll?: boolean;
}

export interface AddCampaignContactsResult {
  campaign: CampaignWithContacts;
  /** New campaign-contact links created. */
  added: number;
  /** Resolved leads that already had a contact row in this campaign. */
  alreadyInCampaign: number;
}

export interface SkippedLead {
  id: string;
  name: string | null;
  phoneNumber: string;
  /** Human-readable summary of why this lead couldn't be deleted, e.g.
   * "2 calls, in 1 other campaign". */
  reason: string;
}

export interface DeleteCampaignLeadsResult {
  campaign: CampaignWithContacts;
  /** Leads permanently deleted. */
  deleted: number;
  /** Leads left untouched because they have call/appointment/follow-up
   * history or are attached to another campaign too. */
  skipped: number;
  skippedLeads: SkippedLead[];
}
