export interface OverviewStats {
  totalLeads: number;
  leadsByStatus: Record<string, number>;
  totalCalls: number;
  callsByStatus: Record<string, number>;
  totalAppointments: number;
  appointmentsByStatus: Record<string, number>;
  activeCampaigns: number;
  totalCampaigns: number;
  pendingFollowUps: number;
  dncCount: number;
  callToAppointmentRate: number;
}

export interface CampaignPerformance {
  id: string;
  name: string;
  status: string;
  totalContacts: number;
  contactsByStatus: Record<string, number>;
  appointmentsBooked: number;
}

export interface CallTimeseriesPoint {
  date: string;
  total: number;
  completed: number;
  failed: number;
  noAnswer: number;
  busy: number;
}

/** Shape of every message delivered over the dashboard-wide SSE feed (GET /api/events/stream). */
export interface DashboardEvent {
  type: string;
  callId: string | null;
  data: unknown;
  timestamp: string;
}
