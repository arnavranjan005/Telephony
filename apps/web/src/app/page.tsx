"use client";

import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import type { DashboardEvent, OverviewStats, CampaignPerformance, CallTimeseriesPoint } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { StatCard } from "@/components/stat-card";
import { ActivityFeed } from "@/components/activity-feed";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Phone, CalendarCheck, Megaphone, PhoneCall, ShieldBan, TrendingUp } from "lucide-react";

// Call outcomes are a state, not an arbitrary series identity, so they use the
// fixed status scale (good/warning/serious/critical) rather than the
// categorical theme - see the dataviz skill's color-formula.md "collision rule".
const chartConfig = {
  completed: { label: "Completed", theme: { light: "#0ca30c", dark: "#0ca30c" } },
  busy: { label: "Busy", theme: { light: "#fab219", dark: "#fab219" } },
  noAnswer: { label: "No answer", theme: { light: "#ec835a", dark: "#ec835a" } },
  failed: { label: "Failed", theme: { light: "#d03b3b", dark: "#d03b3b" } },
} satisfies ChartConfig;

const MAX_ACTIVITY = 25;

export default function DashboardPage() {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [timeseries, setTimeseries] = useState<CallTimeseriesPoint[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignPerformance[] | null>(null);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    Promise.all([apiClient.getOverview(), apiClient.getCallTimeseries(14), apiClient.getCampaignPerformance()])
      .then(([overview, ts, camp]) => {
        setStats(overview);
        setTimeseries(ts.points);
        setCampaigns(camp.campaigns);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        setEvents((prev) => [event, ...prev].slice(0, MAX_ACTIVITY));
        loadAll();
      },
      [loadAll]
    )
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Live overview of calls, leads, campaigns, and appointments.</p>
      </div>

      {error && <p className="text-sm text-destructive">Failed to load analytics: {error}</p>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total leads" value={stats?.totalLeads ?? "…"} icon={Users} />
        <StatCard label="Total calls" value={stats?.totalCalls ?? "…"} icon={Phone} />
        <StatCard
          label="Appointments booked"
          value={stats?.totalAppointments ?? "…"}
          icon={CalendarCheck}
          hint={stats ? `${Math.round(stats.callToAppointmentRate * 100)}% of completed calls` : undefined}
        />
        <StatCard label="Active campaigns" value={stats?.activeCampaigns ?? "…"} icon={Megaphone} hint={stats ? `${stats.totalCampaigns} total` : undefined} />
        <StatCard label="Pending follow-ups" value={stats?.pendingFollowUps ?? "…"} icon={PhoneCall} />
        <StatCard label="Do-not-call entries" value={stats?.dncCount ?? "…"} icon={ShieldBan} />
        <StatCard
          label="Completed calls"
          value={stats?.callsByStatus["COMPLETED"] ?? 0}
          icon={TrendingUp}
          className="sm:col-span-2 lg:col-span-2"
          hint={stats ? `of ${stats.totalCalls} total calls` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Call volume (last 14 days)</CardTitle>
            <CardDescription>Daily call outcomes</CardDescription>
          </CardHeader>
          <CardContent>
            {timeseries ? (
              <ChartContainer config={chartConfig} className="aspect-auto h-72 w-full">
                <BarChart data={timeseries}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey="completed"
                    stackId="a"
                    fill="var(--color-completed)"
                    stroke="var(--card)"
                    strokeWidth={2}
                    radius={[0, 0, 4, 4]}
                  />
                  <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" stroke="var(--card)" strokeWidth={2} />
                  <Bar
                    dataKey="noAnswer"
                    stackId="a"
                    fill="var(--color-noAnswer)"
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  <Bar
                    dataKey="busy"
                    stackId="a"
                    fill="var(--color-busy)"
                    stroke="var(--card)"
                    strokeWidth={2}
                    radius={[4, 4, 0, 0]}
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                </BarChart>
              </ChartContainer>
            ) : (
              <Skeleton className="h-72 w-full" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live activity</CardTitle>
            <CardDescription>Streaming over SSE</CardDescription>
          </CardHeader>
          <CardContent className="max-h-72 overflow-y-auto">
            <ActivityFeed events={events} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Campaign performance</CardTitle>
          <CardDescription>Contact outcomes and appointments booked per campaign</CardDescription>
        </CardHeader>
        <CardContent>
          {campaigns && campaigns.length === 0 && <p className="text-sm text-muted-foreground">No campaigns yet.</p>}
          {campaigns && campaigns.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Contacts</TableHead>
                  <TableHead className="text-right">Called</TableHead>
                  <TableHead className="text-right">Failed / Skipped</TableHead>
                  <TableHead className="text-right">Appointments booked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => {
                  const failedOrSkipped =
                    (c.contactsByStatus["FAILED"] ?? 0) +
                    (c.contactsByStatus["SKIPPED_DNC"] ?? 0) +
                    (c.contactsByStatus["SKIPPED_NO_CONSENT"] ?? 0);
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.totalContacts}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.contactsByStatus["CALLED"] ?? 0}</TableCell>
                      <TableCell className="text-right tabular-nums">{failedOrSkipped}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.appointmentsBooked}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {!campaigns && <Skeleton className="h-32 w-full" />}
        </CardContent>
      </Card>
    </div>
  );
}
