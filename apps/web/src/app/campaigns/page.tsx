"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Campaign, CampaignWithContacts, DashboardEvent, Lead } from "@telephony/shared-types";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CsvDropzone, type CsvParseResult } from "@/components/csv-dropzone";
import { Plus, Play, Pause, Check, Search, X, ChevronDown } from "lucide-react";

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    apiClient
      .listCampaigns()
      .then((data) => setCampaigns(data.campaigns))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        if (event.type.startsWith("campaign.")) load();
      },
      [load]
    )
  );

  async function toggle(campaign: Campaign) {
    try {
      if (campaign.status === "RUNNING") {
        await apiClient.pauseCampaign(campaign.id);
        toast.success(`${campaign.name} paused`);
      } else {
        await apiClient.startCampaign(campaign.id);
        toast.success(`${campaign.name} started`);
      }
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update campaign");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Outbound dialing campaigns and their contact lists.</p>
        </div>
        <CreateCampaignDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            setCreateOpen(false);
            load();
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">Failed to load campaigns: {error}</p>}

      {!campaigns && !error && <Skeleton className="h-96 w-full" />}

      {campaigns && campaigns.length === 0 && <p className="text-sm text-muted-foreground">No campaigns yet.</p>}

      {campaigns && campaigns.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((campaign) => (
              <TableRow key={campaign.id}>
                <TableCell className="cursor-pointer font-medium" onClick={() => setSelectedId(campaign.id)}>
                  {campaign.name}
                </TableCell>
                <TableCell>
                  <StatusBadge status={campaign.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(campaign.createdAt)}</TableCell>
                <TableCell className="text-right">
                  {(campaign.status === "RUNNING" || campaign.status === "PAUSED" || campaign.status === "DRAFT") && (
                    <Button size="sm" variant="outline" onClick={() => toggle(campaign)}>
                      {campaign.status === "RUNNING" ? (
                        <>
                          <Pause /> Pause
                        </>
                      ) : (
                        <>
                          <Play /> Start
                        </>
                      )}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CampaignDetailSheet campaignId={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

// Page size for the campaign lead picker's server-side search. Kept local
// (not imported from @telephony/shared-types) so the web app keeps only
// type-only imports from that package - see apiClient/csv for the rationale.
const PICKER_PAGE_SIZE = 50;

function CreateCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [openingLine, setOpeningLine] = useState("");
  const [objectionPlaybook, setObjectionPlaybook] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [objectionBaseline, setObjectionBaseline] = useState<string | null>(null);
  const [openingLineDefault, setOpeningLineDefault] = useState<string | null>(null);
  // Lead picker (server-side search)
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadSearch, setLeadSearch] = useState("");
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsNextCursor, setLeadsNextCursor] = useState<string | null>(null);
  // The single staged contact list every source feeds, keyed (and de-duped)
  // by phone number so a number can't be added twice - whether it arrives via
  // CSV, the picker, or a typed line.
  const [staged, setStaged] = useState<Map<string, StagedContact>>(new Map());
  const [csvSummary, setCsvSummary] = useState<{ valid: number; invalid: number } | null>(null);
  const [csvKey, setCsvKey] = useState(0); // remounts the dropzone on reset
  const [manualText, setManualText] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [consentGrantedAll, setConsentGrantedAll] = useState(false);

  useEffect(() => {
    apiClient.getObjectionBaseline().then((data) => setObjectionBaseline(data.text));
    apiClient.getOpeningLineDefault().then((data) => setOpeningLineDefault(data.text));
  }, []);

  // Search leads server-side (debounced) so the picker can find any lead in
  // the whole table, not just a preloaded page. Runs on open (empty query =
  // most recent leads) and on every keystroke.
  useEffect(() => {
    if (!open) return;
    const q = leadSearch.trim();
    setLeadsLoading(true);
    const handle = setTimeout(() => {
      apiClient
        .listLeads({ search: q || undefined, limit: PICKER_PAGE_SIZE })
        .then((data) => {
          setLeads(data.leads);
          setLeadsNextCursor(data.nextCursor);
        })
        .catch(() => {})
        .finally(() => setLeadsLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [open, leadSearch]);

  function loadMoreLeads() {
    if (!leadsNextCursor || leadsLoading) return;
    setLeadsLoading(true);
    apiClient
      .listLeads({ search: leadSearch.trim() || undefined, cursor: leadsNextCursor, limit: PICKER_PAGE_SIZE })
      .then((data) => {
        setLeads((prev) => [...prev, ...data.leads]);
        setLeadsNextCursor(data.nextCursor);
      })
      .catch(() => {})
      .finally(() => setLeadsLoading(false));
  }

  /** Adds contacts to the staged map, keeping the first entry per phone. */
  function stage(entries: StagedContact[]) {
    setStaged((prev) => {
      const next = new Map(prev);
      for (const e of entries) {
        const key = e.phoneNumber.trim();
        if (key && !next.has(key)) next.set(key, { ...e, phoneNumber: key });
      }
      return next;
    });
  }

  function unstage(phoneNumber: string) {
    setStaged((prev) => {
      const next = new Map(prev);
      next.delete(phoneNumber);
      return next;
    });
  }

  // Ticking a lead stages it by phone; unticking removes it - regardless of
  // which source originally added that number.
  function toggleLead(lead: Lead) {
    const key = lead.phoneNumber.trim();
    if (staged.has(key)) unstage(key);
    else
      stage([
        {
          phoneNumber: key,
          firstName: lead.firstName ?? undefined,
          lastName: lead.lastName ?? undefined,
          leadId: lead.id,
          source: "lead",
        },
      ]);
  }

  function handleCsvParsed(result: CsvParseResult | null) {
    if (!result) return;
    stage(
      result.valid.map((r) => ({
        phoneNumber: r.lead.phoneNumber,
        firstName: r.lead.firstName,
        lastName: r.lead.lastName,
        source: "csv" as const,
      }))
    );
    setCsvSummary({ valid: result.valid.length, invalid: result.invalid.length });
  }

  function addManual() {
    const entries = manualText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): StagedContact => {
        const [maybeName, maybePhone] = line.split(",").map((s) => s.trim());
        if (maybePhone) {
          const [firstName, ...rest] = maybeName.split(" ");
          return { phoneNumber: maybePhone, firstName, lastName: rest.join(" ") || undefined, source: "manual" };
        }
        return { phoneNumber: maybeName, source: "manual" };
      });
    if (entries.length === 0) return;
    stage(entries);
    setManualText("");
  }

  function reset() {
    setName("");
    setScript("");
    setOpeningLine("");
    setObjectionPlaybook("");
    setStaged(new Map());
    setCsvSummary(null);
    setCsvKey((k) => k + 1);
    setManualText("");
    setManualOpen(false);
    setConsentGrantedAll(false);
    setLeadSearch("");
    setLeadsNextCursor(null);
  }

  async function submit() {
    const contacts = [...staged.values()].map((c) =>
      c.leadId ? { leadId: c.leadId } : { phoneNumber: c.phoneNumber, firstName: c.firstName, lastName: c.lastName }
    );

    if (!name.trim() || !script.trim() || contacts.length === 0) {
      toast.error("Campaign name, call script, and at least one contact are required");
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.createCampaign({
        name,
        script,
        openingLine: openingLine || undefined,
        objectionPlaybook: objectionPlaybook || undefined,
        contacts,
        consentGrantedAll: consentGrantedAll || undefined,
      });
      toast.success(`Campaign created with ${contacts.length} contact${contacts.length === 1 ? "" : "s"}`);
      reset();
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setSubmitting(false);
    }
  }

  const stagedList = [...staged.values()];
  const sourceCounts = stagedList.reduce(
    (acc, c) => ({ ...acc, [c.source]: acc[c.source] + 1 }),
    { csv: 0, lead: 0, manual: 0 } as Record<StagedContact["source"], number>
  );
  const SOURCE_LABEL: Record<StagedContact["source"], string> = { csv: "CSV", lead: "Picker", manual: "Manual" };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogTrigger render={<Button />}>
        <Plus /> New campaign
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>Configure a script and contacts, then start it whenever you're ready.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring promo" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Call script (required)</Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Without one, the model has nothing concrete to work from and may improvise a generic pitch.
            </p>
            <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={3} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Opening line (optional)</Label>
            {openingLineDefault && (
              <p className="border-l-2 pl-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium">Used if left blank: </span>
                &quot;{openingLineDefault}&quot;
              </p>
            )}
            <Input
              value={openingLine}
              onChange={(e) => setOpeningLine(e.target.value)}
              placeholder={'e.g. "Hi, thanks for picking up - I\'m calling about the quote you requested."'}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Objection playbook (optional)</Label>
            {objectionBaseline && (
              <p className="border-l-2 pl-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium">Handled by default: </span>
                {objectionBaseline.replace(/\s+/g, " ").trim()}
              </p>
            )}
            <Textarea
              value={objectionPlaybook}
              onChange={(e) => setObjectionPlaybook(e.target.value)}
              rows={3}
              placeholder={'Only add campaign-specific detail on top of the default above, e.g. "If price is the objection, mention the 3-installment plan"'}
            />
          </div>

          <div className="h-px bg-border" />

          {/* 1. Import CSV — inline, no nested dialog */}
          <div className="flex flex-col gap-1.5">
            <Label>Import CSV</Label>
            <CsvDropzone key={csvKey} onParsed={handleCsvParsed} />
            {csvSummary && (
              <p className="text-xs text-muted-foreground">
                Added <span className="font-medium text-foreground">{csvSummary.valid}</span> from file
                {csvSummary.invalid > 0 && ` · ${csvSummary.invalid} invalid skipped`}
              </p>
            )}
          </div>

          {/* 2. Pick from leads */}
          <div className="flex flex-col gap-1.5">
            <Label>Pick from leads</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
                placeholder="Search leads by name or number"
              />
            </div>
            <div className="max-h-44 overflow-y-auto rounded-md border">
              {leads.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {leadsLoading ? "Searching…" : leadSearch.trim() ? "No leads match that search." : "No leads yet."}
                </p>
              ) : (
                <>
                  {leads.map((lead) => {
                    const key = lead.phoneNumber.trim();
                    const selected = staged.has(key);
                    const fromCsv = staged.get(key)?.source === "csv";
                    return (
                      <button
                        type="button"
                        key={lead.id}
                        onClick={() => toggleLead(lead)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.phoneNumber}
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{lead.phoneNumber}</span>
                        </span>
                        {fromCsv && (
                          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            in CSV
                          </span>
                        )}
                        <span
                          className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                            selected ? "border-primary bg-primary text-primary-foreground" : "border-input"
                          }`}
                        >
                          {selected && <Check className="size-3" />}
                        </span>
                      </button>
                    );
                  })}
                  {leadsNextCursor && (
                    <button
                      type="button"
                      onClick={loadMoreLeads}
                      disabled={leadsLoading}
                      className="w-full px-3 py-1.5 text-center text-xs text-muted-foreground hover:bg-accent"
                    >
                      {leadsLoading ? "Loading…" : "Load more"}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 3. Add manually — collapsed */}
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setManualOpen((v) => !v)}
              aria-expanded={manualOpen}
              className="flex items-center gap-1.5 self-start text-sm font-medium"
            >
              <ChevronDown className={`size-4 text-muted-foreground transition-transform ${manualOpen ? "" : "-rotate-90"}`} />
              Add manually
            </button>
            {manualOpen && (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  rows={3}
                  placeholder={"One per line: Name, +15551234567\nor just +15551234567"}
                />
                <Button type="button" size="sm" variant="outline" className="self-start" onClick={addManual} disabled={!manualText.trim()}>
                  Add to contacts
                </Button>
              </div>
            )}
          </div>

          {/* 4. Contacts to add — the merged, de-duped review list */}
          {stagedList.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label className="mb-0">Contacts to add</Label>
                <span className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums">
                  {stagedList.length}
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {[
                    sourceCounts.csv && `${sourceCounts.csv} CSV`,
                    sourceCounts.lead && `${sourceCounts.lead} picker`,
                    sourceCounts.manual && `${sourceCounts.manual} manual`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="max-h-44 overflow-y-auto rounded-md border">
                {stagedList.slice(0, 100).map((c) => (
                  <div key={c.phoneNumber} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
                    <span className="min-w-0 flex-1 truncate">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") || (
                        <span className="text-muted-foreground">No name</span>
                      )}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{c.phoneNumber}</span>
                    </span>
                    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {SOURCE_LABEL[c.source]}
                    </span>
                    <button
                      type="button"
                      onClick={() => unstage(c.phoneNumber)}
                      aria-label={`Remove ${c.phoneNumber}`}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
                {stagedList.length > 100 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">…and {stagedList.length - 100} more — all will be added</p>
                )}
              </div>
            </div>
          )}

          {/* 5. Consent */}
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Grant TCPA consent to all contacts</p>
              <p className="text-xs text-muted-foreground">
                Marks every lead in this campaign consented, so they can be auto-dialed
              </p>
            </div>
            <Switch checked={consentGrantedAll} onCheckedChange={setConsentGrantedAll} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting || stagedList.length === 0}>
            {stagedList.length > 0 ? `Create campaign · ${stagedList.length}` : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface StagedContact {
  phoneNumber: string;
  firstName?: string;
  lastName?: string;
  /** Set when the contact came from picking an existing lead. */
  leadId?: string;
  source: "csv" | "lead" | "manual";
}

function CampaignDetailSheet({ campaignId, onClose }: { campaignId: string | null; onClose: () => void }) {
  const [campaign, setCampaign] = useState<CampaignWithContacts | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!campaignId) {
      setCampaign(null);
      return;
    }
    setLoading(true);
    apiClient
      .getCampaign(campaignId)
      .then((data) => setCampaign(data.campaign))
      .finally(() => setLoading(false));
  }, [campaignId]);

  return (
    <Sheet open={campaignId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{campaign?.name ?? "Campaign"}</SheetTitle>
          <SheetDescription>{campaign?.contacts.length ?? 0} contacts</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {loading && <Skeleton className="h-64 w-full" />}
          {campaign && !loading && (
            <>
              {campaign.script && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="mb-1 font-medium">Script</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{campaign.script}</p>
                </div>
              )}
              {campaign.openingLine && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="mb-1 font-medium">Opening line</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{campaign.openingLine}</p>
                </div>
              )}
              {campaign.objectionPlaybook && (
                <div className="rounded-md border p-3 text-sm">
                  <p className="mb-1 font-medium">Objection playbook</p>
                  <p className="whitespace-pre-wrap text-muted-foreground">{campaign.objectionPlaybook}</p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                {campaign.contacts.map((contact) => (
                  <div key={contact.id} className="flex items-center justify-between text-sm">
                    <div>
                      <p className="font-medium">
                        {[contact.lead.firstName, contact.lead.lastName].filter(Boolean).join(" ") ||
                          contact.lead.phoneNumber}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">{contact.lead.phoneNumber}</p>
                    </div>
                    <StatusBadge status={contact.status} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
