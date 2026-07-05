import { prisma } from "@telephony/database";

function toCountMap<K extends string>(rows: Array<{ status: K; _count: { _all: number } }>): Record<K, number> {
  const map = {} as Record<K, number>;
  for (const row of rows) map[row.status] = row._count._all;
  return map;
}

function sumValues(map: Record<string, number>): number {
  return Object.values(map).reduce((total, count) => total + count, 0);
}

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
  /** appointments booked per completed call - the "did this call lead to a booking" rate. */
  callToAppointmentRate: number;
}

/**
 * Dashboard-wide snapshot: one round trip of aggregate counts covering
 * leads, calls, appointments, campaigns, follow-ups, and the DNC list.
 * Nothing here is per-entity - see getCampaignPerformance/getCallTimeseries
 * for breakdowns.
 */
export async function getOverviewStats(): Promise<OverviewStats> {
  const [leadRows, callRows, appointmentRows, activeCampaigns, totalCampaigns, pendingFollowUps, dncCount] =
    await Promise.all([
      prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.call.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.appointment.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.campaign.count({ where: { status: "RUNNING" } }),
      prisma.campaign.count(),
      prisma.followUp.count({ where: { status: "PENDING" } }),
      prisma.dncEntry.count(),
    ]);

  const leadsByStatus = toCountMap(leadRows);
  const callsByStatus = toCountMap(callRows);
  const appointmentsByStatus = toCountMap(appointmentRows);

  const totalAppointments = sumValues(appointmentsByStatus);
  const completedCalls = callsByStatus["COMPLETED"] ?? 0;

  return {
    totalLeads: sumValues(leadsByStatus),
    leadsByStatus,
    totalCalls: sumValues(callsByStatus),
    callsByStatus,
    totalAppointments,
    appointmentsByStatus,
    activeCampaigns,
    totalCampaigns,
    pendingFollowUps,
    dncCount,
    callToAppointmentRate: completedCalls === 0 ? 0 : totalAppointments / completedCalls,
  };
}

export interface CampaignPerformance {
  id: string;
  name: string;
  status: string;
  totalContacts: number;
  contactsByStatus: Record<string, number>;
  appointmentsBooked: number;
}

/**
 * Per-campaign performance: how many contacts landed in each dial outcome,
 * and how many of that campaign's calls actually resulted in a booked
 * appointment (traced via CampaignContact -> Call -> Appointment).
 */
export async function getCampaignPerformance(): Promise<CampaignPerformance[]> {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      contacts: {
        select: {
          status: true,
          call: { select: { appointments: { select: { id: true } } } },
        },
      },
    },
  });

  return campaigns.map((campaign) => {
    const contactsByStatus: Record<string, number> = {};
    let appointmentsBooked = 0;

    for (const contact of campaign.contacts) {
      contactsByStatus[contact.status] = (contactsByStatus[contact.status] ?? 0) + 1;
      appointmentsBooked += contact.call?.appointments.length ?? 0;
    }

    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalContacts: campaign.contacts.length,
      contactsByStatus,
      appointmentsBooked,
    };
  });
}

export interface CallTimeseriesPoint {
  date: string;
  total: number;
  completed: number;
  failed: number;
  noAnswer: number;
  busy: number;
}

/**
 * One bucket per calendar day (UTC) for the last `days` days, always
 * present even with zero calls, so a chart never has to fill in gaps
 * itself.
 */
export async function getCallTimeseries(days = 14): Promise<CallTimeseriesPoint[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const calls = await prisma.call.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, status: true },
  });

  const buckets = new Map<string, CallTimeseriesPoint>();
  for (let i = 0; i < days; i++) {
    const date = new Date(since);
    date.setUTCDate(date.getUTCDate() + i);
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, { date: key, total: 0, completed: 0, failed: 0, noAnswer: 0, busy: 0 });
  }

  for (const call of calls) {
    const bucket = buckets.get(call.createdAt.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.total += 1;
    if (call.status === "COMPLETED") bucket.completed += 1;
    else if (call.status === "FAILED") bucket.failed += 1;
    else if (call.status === "NO_ANSWER") bucket.noAnswer += 1;
    else if (call.status === "BUSY") bucket.busy += 1;
  }

  return Array.from(buckets.values());
}
