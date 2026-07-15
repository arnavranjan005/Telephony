"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Campaign, DashboardEvent, Lead, LeadStatus, LeadWithDetails } from "@telephony/shared-types";
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
import { Plus, Upload } from "lucide-react";
import { CsvDropzone } from "@/components/csv-dropzone";
import { type CsvParseResult } from "@/lib/csv";

// Local copy (not a runtime import from @telephony/shared-types) so the web
// app keeps only type-only imports from that package - a value import would
// resolve to its built dist/ and break `npm run dev:web` on a fresh clone.
// The API's BULK_IMPORT_MAX_ROWS is the enforced source of truth; this only
// gates the client-side UX, so a mismatch just changes when the notice shows.
const BULK_IMPORT_MAX_ROWS = 2000;

const STATUS_TABS: Array<LeadStatus | "ALL"> = ["ALL", "COLD", "WARM", "HOT"];

export default function LeadsPage() {
  const [filter, setFilter] = useState<LeadStatus | "ALL">("ALL");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const status = filter === "ALL" ? undefined : filter;

  // Loads the first page (resetting any accumulated pages). Called on mount,
  // on filter change, and whenever a lead.* SSE event lands - new leads sort to
  // the top, so restarting from page one is the correct refresh.
  const load = useCallback(() => {
    apiClient
      .listLeads({ status })
      .then((data) => {
        setLeads(data.leads);
        setNextCursor(data.nextCursor);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [status]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    apiClient
      .listLeads({ status, cursor: nextCursor })
      .then((data) => {
        setLeads((prev) => [...(prev ?? []), ...data.leads]);
        setNextCursor(data.nextCursor);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoadingMore(false));
  }, [status, nextCursor, loadingMore]);

  useEffect(() => {
    setLeads(null);
    setNextCursor(null);
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
        <div className="flex items-center gap-2">
          <ImportLeadsDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            onImported={() => {
              setImportOpen(false);
              load();
            }}
          />
          <CreateLeadDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreated={() => {
              setCreateOpen(false);
              load();
            }}
          />
        </div>
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

      {leads && leads.length > 0 && nextCursor && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
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

function ImportLeadsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [parsed, setParsed] = useState<CsvParseResult | null>(null);
  const [consentGrantedAll, setConsentGrantedAll] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Bumped on reset to remount the dropzone and clear its internal file state.
  const [dropzoneKey, setDropzoneKey] = useState(0);
  // Optional: also attach the imported leads to a campaign that's been
  // drafted but not started yet. "" means "don't assign to a campaign".
  const [draftCampaigns, setDraftCampaigns] = useState<Campaign[]>([]);
  const [assignCampaignId, setAssignCampaignId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    apiClient
      .listCampaigns()
      .then((data) => setDraftCampaigns(data.campaigns.filter((c) => c.status === "DRAFT")))
      .catch(() => {});
  }, [open]);

  function reset() {
    setParsed(null);
    setConsentGrantedAll(false);
    setDropzoneKey((k) => k + 1);
    setAssignCampaignId("");
  }

  const validCount = parsed?.valid.length ?? 0;
  const invalidCount = parsed?.invalid.length ?? 0;
  const overLimit = validCount > BULK_IMPORT_MAX_ROWS;

  async function submit() {
    if (!parsed || validCount === 0) {
      toast.error("No valid rows to import");
      return;
    }
    if (overLimit) {
      toast.error(`Too many rows: ${validCount}. The limit is ${BULK_IMPORT_MAX_ROWS} per import.`);
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiClient.bulkImportLeads({
        leads: parsed.valid.map((r) => r.lead),
        consentGrantedAll: consentGrantedAll || undefined,
      });
      const parts = [`${result.created} imported`];
      const skipped = result.skippedDuplicates + result.duplicatesInFile;
      if (skipped > 0) parts.push(`${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`);
      if (invalidCount > 0) parts.push(`${invalidCount} invalid row${invalidCount === 1 ? "" : "s"} ignored`);

      // Attaching to a campaign is a separate follow-up call (not baked into
      // the import itself) so a campaign that started dialing between
      // opening this dialog and clicking Import doesn't block the leads
      // from being imported - only the attach step fails, reported on its
      // own rather than losing the import.
      if (assignCampaignId) {
        try {
          const campaignName = draftCampaigns.find((c) => c.id === assignCampaignId)?.name ?? "the campaign";
          // Forward the same consent choice: a lead skipped as a duplicate by
          // the leads-bulk call above (already existed, so its consent was
          // untouched) still gets attached to the campaign here - without
          // this, it would land with whatever consent it already had despite
          // the toggle being on, and get silently skipped when the campaign
          // dials. addContactsToCampaign's own consent grant applies to every
          // resolved lead (new and pre-existing alike), closing that gap.
          const attach = await apiClient.addCampaignContacts(assignCampaignId, {
            contacts: parsed.valid.map((r) => r.lead),
            consentGrantedAll: consentGrantedAll || undefined,
          });
          parts.push(`${attach.added} added to ${campaignName}`);
          if (attach.alreadyInCampaign > 0) parts.push(`${attach.alreadyInCampaign} already in it`);
        } catch (attachErr) {
          toast.error(
            attachErr instanceof Error
              ? `Leads imported, but couldn't add to campaign: ${attachErr.message}`
              : "Leads imported, but adding them to the campaign failed"
          );
          reset();
          onImported();
          return;
        }
      }

      toast.success(parts.join(", "));
      reset();
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import leads");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogTrigger render={<Button variant="outline" />}>
        <Upload /> Import CSV
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import leads from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with a <span className="font-mono text-xs">phoneNumber</span> column. Optional columns:
            firstName, lastName, email, status, notes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <CsvDropzone key={dropzoneKey} onParsed={setParsed} />

          {parsed && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md bg-accent px-2 py-0.5 font-medium">{validCount} valid</span>
                {invalidCount > 0 && (
                  <span className="rounded-md bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                    {invalidCount} invalid
                  </span>
                )}
              </div>

              {overLimit && (
                <p className="text-sm text-destructive">
                  {validCount} rows exceeds the {BULK_IMPORT_MAX_ROWS}-row limit. Split the file and import in batches.
                </p>
              )}

              {validCount > 0 && (
                <div className="max-h-48 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsed.valid.slice(0, 20).map((r) => (
                        <TableRow key={r.line}>
                          <TableCell className="font-medium">
                            {[r.lead.firstName, r.lead.lastName].filter(Boolean).join(" ") || "—"}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.lead.phoneNumber}</TableCell>
                          <TableCell>{r.lead.status ?? "COLD"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {validCount > 20 && (
                    <p className="border-t px-3 py-2 text-xs text-muted-foreground">…and {validCount - 20} more</p>
                  )}
                </div>
              )}

              {invalidCount > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">{invalidCount} rows will be skipped</summary>
                  <ul className="mt-1.5 flex flex-col gap-0.5 pl-4">
                    {parsed.invalid.slice(0, 10).map((row) => (
                      <li key={row.line} className="list-disc">
                        Line {row.line}: {row.reason}
                      </li>
                    ))}
                    {invalidCount > 10 && <li className="list-disc">…and {invalidCount - 10} more</li>}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Grant TCPA consent to all imported leads</p>
              <p className="text-xs text-muted-foreground">
                Marks every lead in this file as consented, so they can be dialed automatically
              </p>
            </div>
            <Switch checked={consentGrantedAll} onCheckedChange={setConsentGrantedAll} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Also add to a draft campaign (optional)</Label>
            <Select
              value={assignCampaignId || "none"}
              onValueChange={(value) => setAssignCampaignId(value === "none" ? "" : (value ?? ""))}
            >
              <SelectTrigger>
                <SelectValue placeholder="None">
                  {(value: string | null) =>
                    !value || value === "none" ? "None" : (draftCampaigns.find((c) => c.id === value)?.name ?? "None")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {draftCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {draftCampaigns.length === 0 && (
              <p className="text-xs text-muted-foreground">No draft campaigns yet - only campaigns that haven't started can accept more contacts.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={submitting || validCount === 0 || overLimit}>
            {validCount > 0 ? `Import ${Math.min(validCount, BULK_IMPORT_MAX_ROWS)} leads` : "Import leads"}
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
