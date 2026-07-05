"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DashboardEvent, Lead, LeadStatus, LeadWithDetails } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

const STATUS_TABS: Array<LeadStatus | "ALL"> = ["ALL", "COLD", "WARM", "HOT"];

export default function LeadsPage() {
  const [filter, setFilter] = useState<LeadStatus | "ALL">("ALL");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .listLeads(filter === "ALL" ? undefined : filter)
      .then((data) => setLeads(data.leads))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [filter]);

  useEffect(() => {
    setLeads(null);
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        if (event.type.startsWith("lead.")) load();
      },
      [load]
    )
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
        <p className="text-sm text-muted-foreground">Every contact tracked by the platform, with status and consent.</p>
      </div>

      <Tabs value={filter} onValueChange={(value) => setFilter(value as LeadStatus | "ALL")}>
        <TabsList>
          {STATUS_TABS.map((status) => (
            <TabsTrigger key={status} value={status}>
              {status === "ALL" ? "All" : status.charAt(0) + status.slice(1).toLowerCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && <p className="text-sm text-destructive">Failed to load leads: {error}</p>}

      {!leads && !error && <Skeleton className="h-96 w-full" />}

      {leads && leads.length === 0 && <p className="text-sm text-muted-foreground">No leads yet.</p>}

      {leads && leads.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Consent</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => (
              <TableRow key={lead.id} className="cursor-pointer" onClick={() => setSelectedLeadId(lead.id)}>
                <TableCell className="font-medium">
                  {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">{lead.phoneNumber}</TableCell>
                <TableCell>
                  <StatusBadge status={lead.status} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={lead.consentStatus} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(lead.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <LeadDetailSheet leadId={selectedLeadId} onClose={() => setSelectedLeadId(null)} onChanged={load} />
    </div>
  );
}

function LeadDetailSheet({
  leadId,
  onClose,
  onChanged,
}: {
  leadId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lead, setLead] = useState<LeadWithDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!leadId) {
      setLead(null);
      return;
    }
    setLoading(true);
    apiClient
      .getLead(leadId)
      .then((data) => {
        setLead(data.lead);
        setNotes(data.lead.notes ?? "");
      })
      .finally(() => setLoading(false));
  }, [leadId]);

  async function updateStatus(status: LeadStatus) {
    if (!lead) return;
    setSaving(true);
    try {
      const { lead: updated } = await apiClient.updateLead(lead.id, { status });
      setLead({ ...lead, ...updated });
      onChanged();
      toast.success("Lead status updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update lead");
    } finally {
      setSaving(false);
    }
  }

  async function saveNotes() {
    if (!lead) return;
    setSaving(true);
    try {
      const { lead: updated } = await apiClient.updateLead(lead.id, { notes });
      setLead({ ...lead, ...updated });
      onChanged();
      toast.success("Notes saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }

  async function toggleConsent(granted: boolean) {
    if (!lead) return;
    setSaving(true);
    try {
      const { lead: updated } = await apiClient.setLeadConsent(lead.id, { granted, source: "admin_panel" });
      setLead({ ...lead, ...updated });
      onChanged();
      toast.success(granted ? "Consent granted" : "Consent revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update consent");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={leadId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{lead ? [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.phoneNumber : "Lead"}</SheetTitle>
          <SheetDescription>{lead?.phoneNumber}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {loading && <Skeleton className="h-64 w-full" />}

          {lead && !loading && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Status</Label>
                  <Select value={lead.status} onValueChange={(value) => value && updateStatus(value as LeadStatus)}>
                    <SelectTrigger disabled={saving}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="COLD">Cold</SelectItem>
                      <SelectItem value="WARM">Warm</SelectItem>
                      <SelectItem value="HOT">Hot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Email</Label>
                  <Input value={lead.email ?? ""} readOnly disabled />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">TCPA consent</p>
                  <p className="text-xs text-muted-foreground">
                    {lead.consentStatus === "GRANTED" ? "Granted, can be dialed automatically" : "Required before automated dialing"}
                  </p>
                </div>
                <Switch checked={lead.consentStatus === "GRANTED"} onCheckedChange={toggleConsent} disabled={saving} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
                <Button size="sm" className="self-start" onClick={saveNotes} disabled={saving}>
                  Save notes
                </Button>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Recent calls</p>
                {lead.calls.length === 0 && <p className="text-sm text-muted-foreground">No calls yet.</p>}
                <div className="flex flex-col gap-1.5">
                  {lead.calls.slice(0, 8).map((call) => (
                    <div key={call.id} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{formatDateTime(call.startedAt ?? call.createdAt)}</span>
                      <StatusBadge status={call.status} />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Appointments</p>
                {lead.appointments.length === 0 && <p className="text-sm text-muted-foreground">None booked.</p>}
                <div className="flex flex-col gap-1.5">
                  {lead.appointments.map((appt) => (
                    <div key={appt.id} className="flex items-center justify-between text-sm">
                      <span>{appt.title}</span>
                      <span className="text-muted-foreground">{formatDateTime(appt.startTime)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
