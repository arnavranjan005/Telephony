const leadGroupBy = jest.fn();
const callGroupBy = jest.fn();
const appointmentGroupBy = jest.fn();
const campaignCount = jest.fn();
const followUpCount = jest.fn();
const dncCount = jest.fn();
const campaignFindMany = jest.fn();
const callFindMany = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    lead: { groupBy: (...args: unknown[]) => leadGroupBy(...args) },
    call: {
      groupBy: (...args: unknown[]) => callGroupBy(...args),
      findMany: (...args: unknown[]) => callFindMany(...args),
    },
    appointment: { groupBy: (...args: unknown[]) => appointmentGroupBy(...args) },
    campaign: {
      count: (...args: unknown[]) => campaignCount(...args),
      findMany: (...args: unknown[]) => campaignFindMany(...args),
    },
    followUp: { count: (...args: unknown[]) => followUpCount(...args) },
    dncEntry: { count: (...args: unknown[]) => dncCount(...args) },
  },
}));

import { getCallTimeseries, getCampaignPerformance, getOverviewStats } from "./analyticsService";

describe("analyticsService", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("getOverviewStats", () => {
    it("aggregates counts and derives the call-to-appointment rate", async () => {
      leadGroupBy.mockResolvedValue([
        { status: "COLD", _count: { _all: 3 } },
        { status: "HOT", _count: { _all: 2 } },
      ]);
      callGroupBy.mockResolvedValue([
        { status: "COMPLETED", _count: { _all: 10 } },
        { status: "FAILED", _count: { _all: 5 } },
      ]);
      appointmentGroupBy.mockResolvedValue([{ status: "SCHEDULED", _count: { _all: 4 } }]);
      campaignCount.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
      followUpCount.mockResolvedValue(7);
      dncCount.mockResolvedValue(1);

      const stats = await getOverviewStats();

      expect(stats.totalLeads).toBe(5);
      expect(stats.leadsByStatus).toEqual({ COLD: 3, HOT: 2 });
      expect(stats.totalCalls).toBe(15);
      expect(stats.totalAppointments).toBe(4);
      expect(stats.activeCampaigns).toBe(2);
      expect(stats.totalCampaigns).toBe(5);
      expect(stats.pendingFollowUps).toBe(7);
      expect(stats.dncCount).toBe(1);
      expect(stats.callToAppointmentRate).toBeCloseTo(4 / 10);
    });

    it("does not divide by zero when there are no completed calls", async () => {
      leadGroupBy.mockResolvedValue([]);
      callGroupBy.mockResolvedValue([]);
      appointmentGroupBy.mockResolvedValue([]);
      campaignCount.mockResolvedValue(0);
      followUpCount.mockResolvedValue(0);
      dncCount.mockResolvedValue(0);

      const stats = await getOverviewStats();

      expect(stats.callToAppointmentRate).toBe(0);
    });
  });

  describe("getCampaignPerformance", () => {
    it("counts contacts by status and appointments booked via each contact's call", async () => {
      campaignFindMany.mockResolvedValue([
        {
          id: "camp_1",
          name: "Spring Promo",
          status: "RUNNING",
          contacts: [
            { status: "CALLED", call: { appointments: [{ id: "appt_1" }] } },
            { status: "CALLED", call: { appointments: [] } },
            { status: "PENDING", call: null },
          ],
        },
      ]);

      const [performance] = await getCampaignPerformance();

      expect(performance.totalContacts).toBe(3);
      expect(performance.contactsByStatus).toEqual({ CALLED: 2, PENDING: 1 });
      expect(performance.appointmentsBooked).toBe(1);
    });
  });

  describe("getCallTimeseries", () => {
    it("buckets calls by UTC day and always includes every day in range", async () => {
      const today = new Date();
      today.setUTCHours(12, 0, 0, 0);

      callFindMany.mockResolvedValue([
        { createdAt: today, status: "COMPLETED" },
        { createdAt: today, status: "FAILED" },
      ]);

      const points = await getCallTimeseries(3);

      expect(points).toHaveLength(3);
      const todayKey = today.toISOString().slice(0, 10);
      const todayPoint = points.find((p) => p.date === todayKey);
      expect(todayPoint).toEqual({ date: todayKey, total: 2, completed: 1, failed: 1, noAnswer: 0, busy: 0 });
    });
  });
});
