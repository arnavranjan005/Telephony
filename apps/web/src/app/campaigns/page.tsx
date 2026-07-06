"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { Campaign, CampaignWithContacts, DashboardEvent } from "@telephony/shared-types";
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
import { Plus, Play, Pause } from "lucide-react";

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
  const [objectionPlaybook, setObjectionPlaybook] = useState("");
  const [contactsText, setContactsText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const contacts = contactsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [maybeName, maybePhone] = line.split(",").map((s) => s.trim());
        if (maybePhone) {
          const [firstName, ...rest] = maybeName.split(" ");
          return { phoneNumber: maybePhone, firstName, lastName: rest.join(" ") || undefined };
        }
        return { phoneNumber: maybeName };
      });

    if (!name.trim() || contacts.length === 0) {
      toast.error("Campaign name and at least one contact are required");
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.createCampaign({
        name,
        script: script || undefined,
        objectionPlaybook: objectionPlaybook || undefined,
        contacts,
      });
      toast.success("Campaign created");
      setName("");
      setScript("");
      setObjectionPlaybook("");
      setContactsText("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button />}>
        <Plus /> New campaign
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>Configure a script and contact list, then start it whenever you're ready.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring promo" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Call script (guidance for the AI agent)</Label>
            <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={3} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Objection playbook (optional)</Label>
            <Textarea
              value={objectionPlaybook}
              onChange={(e) => setObjectionPlaybook(e.target.value)}
              rows={3}
              placeholder={'e.g. "If price is the objection, mention the 3-installment plan"'}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Contacts</Label>
            <Textarea
              value={contactsText}
              onChange={(e) => setContactsText(e.target.value)}
              rows={5}
              placeholder={"One per line: Name, +15551234567\nor just +15551234567"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={submitting}>
            Create campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
