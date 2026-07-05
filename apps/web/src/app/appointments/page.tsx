"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { AppointmentWithLead, DashboardEvent } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<AppointmentWithLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
        <p className="text-sm text-muted-foreground">Bookings made during calls, synced with Google Calendar.</p>
      </div>

      {error && <p className="text-sm text-destructive">Failed to load appointments: {error}</p>}

      {!appointments && !error && <Skeleton className="h-96 w-full" />}

      {appointments && appointments.length === 0 && <p className="text-sm text-muted-foreground">No appointments yet.</p>}

      {appointments && appointments.length > 0 && (
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
                    <Button size="sm" variant="outline" onClick={() => cancel(appt.id)}>
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
