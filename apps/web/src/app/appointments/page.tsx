"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { AppointmentWithLead, DashboardEvent } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { CalendarDays, List as ListIcon } from "lucide-react";

/** Local-calendar-day key ("2026-07-05"), so grouping matches whatever day a
 * user actually sees the appointment time rendered on (browser-local time),
 * not UTC. */
function dayKey(value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function AppointmentsTable({
  appointments,
  onCancel,
}: {
  appointments: AppointmentWithLead[];
  onCancel: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Lead</TableHead>
          <TableHead>Start</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {appointments.map((appt) => (
          <TableRow key={appt.id}>
            <TableCell className="font-medium">{appt.title}</TableCell>
            <TableCell>
              {appt.lead ? [appt.lead.firstName, appt.lead.lastName].filter(Boolean).join(" ") || appt.lead.phoneNumber : "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime(appt.startTime)}</TableCell>
            <TableCell>
              <StatusBadge status={appt.status} />
            </TableCell>
            <TableCell className="text-right">
              {(appt.status === "SCHEDULED" || appt.status === "CONFIRMED") && (
                <Button size="sm" variant="outline" onClick={() => onCancel(appt.id)}>
                  Cancel
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<AppointmentWithLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());

  const load = useCallback(() => {
    apiClient
      .listAppointments()
      .then((data) => setAppointments(data.appointments))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        if (event.type.startsWith("appointment.")) load();
      },
      [load]
    )
  );

  async function cancel(id: string) {
    try {
      await apiClient.cancelAppointment(id);
      toast.success("Appointment canceled");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel appointment");
    }
  }

  const appointmentsByDay = useMemo(() => {
    const map = new Map<string, AppointmentWithLead[]>();
    for (const appt of appointments ?? []) {
      const key = dayKey(appt.startTime);
      const list = map.get(key);
      if (list) list.push(appt);
      else map.set(key, [appt]);
    }
    return map;
  }, [appointments]);

  const selectedDayAppointments = appointmentsByDay.get(dayKey(selectedDate)) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
          <p className="text-sm text-muted-foreground">Bookings made during calls, synced with Google Calendar.</p>
        </div>
        <Tabs value={view} onValueChange={(value) => value && setView(value as "list" | "calendar")}>
          <TabsList>
            <TabsTrigger value="list">
              <ListIcon /> List
            </TabsTrigger>
            <TabsTrigger value="calendar">
              <CalendarDays /> Calendar
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {error && <p className="text-sm text-destructive">Failed to load appointments: {error}</p>}

      {!appointments && !error && <Skeleton className="h-96 w-full" />}

      {appointments && appointments.length === 0 && <p className="text-sm text-muted-foreground">No appointments yet.</p>}

      {appointments && appointments.length > 0 && view === "list" && (
        <AppointmentsTable appointments={appointments} onCancel={cancel} />
      )}

      {appointments && appointments.length > 0 && view === "calendar" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[auto_1fr]">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => date && setSelectedDate(date)}
            modifiers={{ hasAppointment: (date) => appointmentsByDay.has(dayKey(date)) }}
            modifiersClassNames={{
              hasAppointment:
                "after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-primary data-[selected-single=true]:after:bg-primary-foreground",
            }}
            className="rounded-md border shadow-sm"
          />
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} ·{" "}
              {selectedDayAppointments.length} appointment{selectedDayAppointments.length === 1 ? "" : "s"}
            </p>
            {selectedDayAppointments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No appointments on this day.</p>
            ) : (
              <AppointmentsTable appointments={selectedDayAppointments} onCancel={cancel} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
