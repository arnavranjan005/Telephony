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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

const STATUS_TABS: Array<LeadStatus | "ALL"> = ["ALL", "COLD", "WARM", "HOT"];

export default function LeadsPage() {
  const [filter, setFilter] = useState<LeadStatus | "ALL">("ALL");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">Every contact tracked by the platform, with status and consent.</p>
        </div>
        <CreateLeadDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            setCreateOpen(false);
            load();
          }}
        />
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

function CreateLeadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [consentGranted, setConsentGranted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setFirstName("");
    setLastName("");
    setPhoneNumber("");
    setConsentGranted(false);
  }

  async function submit() {
    if (!phoneNumber.trim()) {
      toast.error("Phone number is required");
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.createLead({
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        phoneNumber: phoneNumber.trim(),
        consentGranted: consentGranted || undefined,
      });
      toast.success("Lead created");
      reset();
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create lead");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button />}>
        <Plus /> New lead
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New lead</DialogTitle>
          <DialogDescription>Add a contact so it's ready to call - via a campaign or one-off.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>First name</Label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Last name</Label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Phone number</Label>
            <Input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+15551234567" />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Grant TCPA consent now</p>
              <p className="text-xs text-muted-foreground">Required before this lead can be dialed automatically</p>
            </div>
            <Switch checked={consentGranted} onCheckedChange={setConsentGranted} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting}>
            Create lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
