"use client";

import { useCallback, useEffect, useState } from "react";
import type { Call, CallWithDetails, DashboardEvent, MessageRole } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { LiveCallTranscript } from "@/components/live-call-transcript";
import { StatusBadge } from "@/components/status-badge";
import { formatDateTime, formatDuration } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ArrowDownLeft, ArrowUpRight, Download, Mic } from "lucide-react";

function LiveDuration({ startedAt }: { startedAt: string | null }) {
  const elapsed = useElapsedSeconds(startedAt);
  return <span className="tabular-nums">{elapsed !== null ? formatDuration(elapsed) : "—"}</span>;
}

const ROLE_STYLES: Record<MessageRole, string> = {
  USER: "bg-muted",
  ASSISTANT: "bg-primary/10",
  SYSTEM: "bg-transparent text-muted-foreground italic",
  TOOL: "bg-amber-500/10",
};

export default function CallsPage() {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallWithDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    apiClient
      .listCalls()
      .then((data) => setCalls(data.calls))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        // call.transcript is per-turn chatter that never changes anything
        // rendered in this table (direction/status/duration/etc) - reloading
        // the whole list for it would refetch on every utterance of every
        // live call for no visible change.
        if (event.type.startsWith("call.") && event.type !== "call.transcript") load();
      },
      [load]
    )
  );

  useEffect(() => {
    if (!selectedCallId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    apiClient
      .getCall(selectedCallId)
      .then((data) => setDetail(data.call))
      .finally(() => setDetailLoading(false));
  }, [selectedCallId]);

  const refreshDetail = useCallback(() => {
    if (!selectedCallId) return;
    apiClient.getCall(selectedCallId).then((data) => setDetail(data.call));
  }, [selectedCallId]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Calls</h1>
        <p className="text-sm text-muted-foreground">Every inbound and outbound call, with live status updates.</p>
      </div>

      {error && <p className="text-sm text-destructive">Failed to load calls: {error}</p>}

      {!calls && !error && <Skeleton className="h-96 w-full" />}

      {calls && calls.length === 0 && <p className="text-sm text-muted-foreground">No calls yet.</p>}

      {calls && calls.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Direction</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call) => (
              <TableRow key={call.id} className="cursor-pointer" onClick={() => setSelectedCallId(call.id)}>
                <TableCell>
                  {call.direction === "INBOUND" ? (
                    <Badge variant="secondary" className="gap-1">
                      <ArrowDownLeft className="size-3" /> In
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1">
                      <ArrowUpRight className="size-3" /> Out
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{call.fromNumber}</TableCell>
                <TableCell className="font-mono text-xs">{call.toNumber}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={call.status} />
                    {call.status === "IN_PROGRESS" && (
                      <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" title="Live" />
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {call.status === "IN_PROGRESS" ? (
                    <LiveDuration startedAt={call.startedAt} />
                  ) : (
                    <span className="tabular-nums">{formatDuration(call.durationSeconds)}</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(call.startedAt ?? call.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={selectedCallId !== null} onOpenChange={(open) => !open && setSelectedCallId(null)}>
        <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Call details</SheetTitle>
            <SheetDescription>
              {detail ? `${detail.fromNumber} → ${detail.toNumber}` : "Loading…"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 px-4 pb-6">
            {detailLoading && <Skeleton className="h-64 w-full" />}

            {detail && !detailLoading && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={detail.status} />
                  {detail.status === "IN_PROGRESS" ? (
                    <LiveDuration startedAt={detail.startedAt} />
                  ) : (
                    <span className="text-muted-foreground">{formatDuration(detail.durationSeconds)}</span>
                  )}
                  {detail.outcome && <span className="text-muted-foreground">· {detail.outcome}</span>}
                </div>

                {detail.recordingUrl && (
                  <div className="rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        <Mic className="size-3.5 text-muted-foreground" /> Recording
                      </p>
                      <a
                        href={apiClient.recordingHref(detail.id, { download: true })}
                        className={buttonVariants({ variant: "outline", size: "xs" })}
                      >
                        <Download /> Download
                      </a>
                    </div>
                    {/* Native player; API streams a fresh Telnyx recording per request. */}
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <audio controls preload="none" className="h-9 w-full" src={apiClient.recordingHref(detail.id)}>
                      Your browser does not support audio playback.
                    </audio>
                  </div>
                )}

                {detail.appointments.length > 0 && (
                  <div className="rounded-md border p-3 text-sm">
                    <p className="mb-1 font-medium">Appointments booked on this call</p>
                    {detail.appointments.map((appt) => (
                      <p key={appt.id} className="text-muted-foreground">
                        {appt.title} — {formatDateTime(appt.startTime)}
                      </p>
                    ))}
                  </div>
                )}

                {(detail.messages.length > 0 || detail.status !== "IN_PROGRESS") && (
                  <div>
                    <p className="mb-2 text-sm font-medium">Transcript</p>
                    {detail.messages.length === 0 && (
                      <p className="text-sm text-muted-foreground">No conversation recorded for this call.</p>
                    )}
                    <div className="flex flex-col gap-2">
                      {detail.messages
                        .filter((m) => m.role !== "SYSTEM")
                        .map((message) => (
                          <div key={message.id} className={`rounded-md px-3 py-2 text-sm ${ROLE_STYLES[message.role]}`}>
                            <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="font-medium">{message.role}</span>
                              {message.toolName && <span>· {message.toolName}</span>}
                              {message.interrupted && <span>· interrupted</span>}
                            </div>
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {detail.status === "IN_PROGRESS" && (
                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium">
                      {detail.messages.length > 0 ? "Live continuation" : "Live transcript"}
                    </p>
                    <LiveCallTranscript callId={detail.id} onHangup={refreshDetail} />
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
