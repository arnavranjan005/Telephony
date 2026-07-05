"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DashboardEvent, DncEntry } from "@telephony/shared-types";
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
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function DncPage() {
  const [entries, setEntries] = useState<DncEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    apiClient
      .listDnc()
      .then((data) => setEntries(data.entries))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        if (event.type.startsWith("dnc.")) load();
      },
      [load]
    )
  );

  async function remove(phoneNumber: string) {
    try {
      await apiClient.removeDncEntry(phoneNumber);
      toast.success("Removed from Do-Not-Call list");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove entry");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Do-Not-Call list</h1>
          <p className="text-sm text-muted-foreground">Numbers excluded from all automated dialing.</p>
        </div>
        <AddDncDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onAdded={() => {
            setCreateOpen(false);
            load();
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">Failed to load the DNC list: {error}</p>}

      {!entries && !error && <Skeleton className="h-96 w-full" />}

      {entries && entries.length === 0 && <p className="text-sm text-muted-foreground">No numbers on the list.</p>}

      {entries && entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone number</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono text-xs">{entry.phoneNumber}</TableCell>
                <TableCell className="text-muted-foreground">{entry.reason ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={entry.source} />
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => remove(entry.phoneNumber)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function AddDncDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!phoneNumber.trim()) {
      toast.error("Phone number is required");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.addDncEntry({ phoneNumber: phoneNumber.trim(), reason: reason || undefined });
      toast.success("Added to Do-Not-Call list");
      setPhoneNumber("");
      setReason("");
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add entry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button />}>
        <Plus /> Add number
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Do-Not-Call list</DialogTitle>
          <DialogDescription>This number will be excluded from every automated dial going forward.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Phone number</Label>
            <Input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="+15551234567" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
