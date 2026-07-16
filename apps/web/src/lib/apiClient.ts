import type {
  AddCampaignContactsInput,
  AddCampaignContactsResult,
  Appointment,
  AppointmentStatus,
  AppointmentWithLead,
  BulkCreateLeadsInput,
  BulkImportResult,
  Call,
  CallStatus,
  CallWithDetails,
  CallTimeseriesPoint,
  Campaign,
  CampaignPerformance,
  CampaignWithContacts,
  CreateCampaignInput,
  CreateFollowUpInput,
  CreateLeadInput,
  DeleteCampaignLeadsResult,
  DncEntry,
  FollowUp,
  FollowUpStatus,
  FollowUpWithLead,
  Lead,
  LeadsPage,
  LeadStatus,
  LeadWithDetails,
  OverviewStats,
  SetLeadConsentInput,
  UpdateLeadInput,
} from "@telephony/shared-types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ? JSON.stringify(body.error) : `Request to ${path} failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  if (entries.length === 0) return "";
  return `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`;
}

/**
 * Thin typed client over the Express API. Every call happens in the
 * browser (this file is only ever imported from client components) - the
 * admin panel has no server-side code of its own (static export).
 */
export const apiClient = {
  // Analytics
  getOverview: () => apiFetch<OverviewStats>("/api/analytics/overview"),
  getCampaignPerformance: () => apiFetch<{ campaigns: CampaignPerformance[] }>("/api/analytics/campaigns"),
  getCallTimeseries: (days = 14) => apiFetch<{ points: CallTimeseriesPoint[] }>(`/api/analytics/timeseries${query({ days })}`),

  // Calls
  listCalls: () => apiFetch<{ calls: Call[] }>("/api/calls"),
  getCall: (callId: string) => apiFetch<{ call: CallWithDetails }>(`/api/calls/${callId}`),
  // Absolute URL to a call's recording. The endpoint streams the audio from
  // Telnyx through the API (same-origin, range-enabled), so it's safe to use
  // directly as an <audio> src. Pass { download: true } to force a file
  // download (Content-Disposition: attachment) instead of inline playback.
  recordingHref: (callId: string, opts?: { download?: boolean }) =>
    `${API_URL}/api/calls/${callId}/recording${opts?.download ? "?download=1" : ""}`,
  createOutboundCall: (input: { toNumber: string; leadId?: string; streaming?: boolean }) =>
    apiFetch<{ call: Call }>("/api/calls/outbound", { method: "POST", body: JSON.stringify(input) }),

  // Leads
  listLeads: (params?: { status?: LeadStatus; cursor?: string; limit?: number; search?: string }) =>
    apiFetch<LeadsPage>(
      `/api/leads${query({ status: params?.status, cursor: params?.cursor, limit: params?.limit, search: params?.search })}`
    ),
  getLead: (leadId: string) => apiFetch<{ lead: LeadWithDetails }>(`/api/leads/${leadId}`),
  createLead: (input: CreateLeadInput) =>
    apiFetch<{ lead: Lead }>("/api/leads", { method: "POST", body: JSON.stringify(input) }),
  bulkImportLeads: (input: BulkCreateLeadsInput) =>
    apiFetch<BulkImportResult>("/api/leads/bulk", { method: "POST", body: JSON.stringify(input) }),
  updateLead: (leadId: string, input: UpdateLeadInput) =>
    apiFetch<{ lead: Lead }>(`/api/leads/${leadId}`, { method: "PATCH", body: JSON.stringify(input) }),
  setLeadConsent: (leadId: string, input: SetLeadConsentInput) =>
    apiFetch<{ lead: Lead }>(`/api/leads/${leadId}/consent`, { method: "POST", body: JSON.stringify(input) }),
  deleteLead: (leadId: string) => apiFetch<void>(`/api/leads/${leadId}`, { method: "DELETE" }),

  // Campaigns
  listCampaigns: () => apiFetch<{ campaigns: Campaign[] }>("/api/campaigns"),
  getObjectionBaseline: () => apiFetch<{ text: string }>("/api/campaigns/objection-baseline"),
  getOpeningLineDefault: () => apiFetch<{ text: string }>("/api/campaigns/opening-line-default"),
  getCampaign: (campaignId: string) => apiFetch<{ campaign: CampaignWithContacts }>(`/api/campaigns/${campaignId}`),
  createCampaign: (input: CreateCampaignInput) =>
    apiFetch<{ campaign: CampaignWithContacts }>("/api/campaigns", { method: "POST", body: JSON.stringify(input) }),
  addCampaignContacts: (campaignId: string, input: AddCampaignContactsInput) =>
    apiFetch<AddCampaignContactsResult>(`/api/campaigns/${campaignId}/contacts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteCampaignLeads: (campaignId: string) =>
    apiFetch<DeleteCampaignLeadsResult>(`/api/campaigns/${campaignId}/contacts`, { method: "DELETE" }),
  startCampaign: (campaignId: string) =>
    apiFetch<{ campaign: Campaign }>(`/api/campaigns/${campaignId}/start`, { method: "POST" }),
  pauseCampaign: (campaignId: string) =>
    apiFetch<{ campaign: Campaign }>(`/api/campaigns/${campaignId}/pause`, { method: "POST" }),

  // Appointments
  listAppointments: (status?: AppointmentStatus) =>
    apiFetch<{ appointments: AppointmentWithLead[] }>(`/api/appointments${query({ status })}`),
  cancelAppointment: (appointmentId: string) =>
    apiFetch<{ appointment: Appointment }>(`/api/appointments/${appointmentId}/cancel`, { method: "POST" }),

  // Follow-ups
  listFollowUps: (status?: FollowUpStatus) =>
    apiFetch<{ followUps: FollowUpWithLead[] }>(`/api/followups${query({ status })}`),
  createFollowUp: (input: CreateFollowUpInput) =>
    apiFetch<{ followUp: FollowUp }>("/api/followups", { method: "POST", body: JSON.stringify(input) }),
  cancelFollowUp: (followUpId: string) =>
    apiFetch<{ followUp: FollowUp }>(`/api/followups/${followUpId}/cancel`, { method: "POST" }),

  // DNC
  listDnc: () => apiFetch<{ entries: DncEntry[] }>("/api/dnc"),
  addDncEntry: (input: { phoneNumber: string; reason?: string }) =>
    apiFetch<{ entry: DncEntry }>("/api/dnc", { method: "POST", body: JSON.stringify(input) }),
  removeDncEntry: (phoneNumber: string) =>
    apiFetch<void>(`/api/dnc/${encodeURIComponent(phoneNumber)}`, { method: "DELETE" }),
};

export type { CallStatus };
