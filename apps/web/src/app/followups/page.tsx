"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DashboardEvent, FollowUpWithLead, Lead } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

const CANCELABLE = new Set(["PENDING", "WAITING_FOR_CALLING_HOURS"]);

export default function FollowUpsPage() {
  const [followUps, setFollowUps] = useState<FollowUpWithLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    apiClient
      .listFollowUps()
      .then((data) => setFollowUps(data.followUps))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        if (event.type.startsWith("followup.")) load();
      },
      [load]
    )
  );

  async function cancel(id: string) {
    try {
      await apiClient.cancelFollowUp(id);
      toast.success("Follow-up canceled");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel follow-up");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Follow-ups</h1>
          <p className="text-sm text-muted-foreground">Scheduled callbacks, automatically dialed at the right time.</p>
        </div>
        <CreateFollowUpDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            setCreateOpen(false);
            load();
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">Failed to load follow-ups: {error}</p>}

      {!followUps && !error && <Skeleton className="h-96 w-full" />}

      {followUps && followUps.length === 0 && <p className="text-sm text-muted-foreground">No follow-ups scheduled.</p>}

      {followUps && followUps.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Scheduled</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {followUps.map((followUp) => (
              <TableRow key={followUp.id}>
                <TableCell className="font-medium">{followUp.lead.name || followUp.lead.phoneNumber}</TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(followUp.scheduledAt)}</TableCell>
                <TableCell className="text-muted-foreground">{followUp.reason ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={followUp.status} />
                </TableCell>
                <TableCell className="text-right">
                  {CANCELABLE.has(followUp.status) && (
                    <Button size="sm" variant="outline" onClick={() => cancel(followUp.id)}>
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

function CreateFollowUpDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadId, setLeadId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) apiClient.listLeads({ limit: 200 }).then((data) => setLeads(data.leads));
  }, [open]);

  async function submit() {
    if (!leadId || !scheduledAt) {
      toast.error("Pick a lead and a time");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.createFollowUp({
        leadId,
        scheduledAt: new Date(scheduledAt).toISOString(),
        reason: reason || undefined,
      });
      toast.success("Follow-up scheduled");
      setLeadId("");
      setScheduledAt("");
      setReason("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to schedule follow-up");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button />}>
        <Plus /> Schedule follow-up
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a follow-up</DialogTitle>
          <DialogDescription>The lead will be dialed automatically at the scheduled time.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Lead</Label>
            <Select value={leadId} onValueChange={(value) => setLeadId(value ?? "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select a lead" />
              </SelectTrigger>
              <SelectContent>
                {leads.map((lead) => (
                  <SelectItem key={lead.id} value={lead.id}>
                    {lead.name || lead.phoneNumber} — {lead.phoneNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Scheduled time</Label>
            <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Caller asked to be called back" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting}>
            Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
