"use client";

import { useCallback, useEffect, useState } from "react";
import type { Call, DashboardEvent } from "@telephony/shared-types";
import { apiClient } from "@/lib/apiClient";
import { useEventStream } from "@/hooks/useEventStream";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { LiveCallTranscript } from "@/components/live-call-transcript";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, PhoneCall } from "lucide-react";
import { cn } from "@/lib/utils";

function LiveCallRow({ call, expanded, onToggle }: { call: Call; expanded: boolean; onToggle: () => void }) {
  const elapsed = useElapsedSeconds(call.startedAt);
  const minutes = elapsed !== null ? Math.floor(elapsed / 60) : 0;
  const seconds = elapsed !== null ? elapsed % 60 : 0;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        <span className="flex size-2 shrink-0 rounded-full bg-emerald-500 animate-pulse" aria-hidden />
        <Badge variant="secondary" className="gap-1">
          {call.direction === "INBOUND" ? <ArrowDownLeft className="size-3" /> : <ArrowUpRight className="size-3" />}
          {call.direction === "INBOUND" ? "In" : "Out"}
        </Badge>
        <span className="font-mono text-xs">{call.direction === "INBOUND" ? call.fromNumber : call.toNumber}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {minutes}:{seconds.toString().padStart(2, "0")}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="border-t px-3 py-3">
          <LiveCallTranscript callId={call.id} />
        </div>
      )}
    </div>
  );
}

/**
 * Dashboard-wide live call monitoring: lists every call currently
 * IN_PROGRESS and lets you expand one to watch its transcript stream in
 * real time (LiveCallTranscript, over the per-call SSE feed) without
 * leaving the dashboard or refetching anything.
 */
export function LiveCallsPanel() {
  const [liveCalls, setLiveCalls] = useState<Call[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient.listCalls().then((data) => {
      setLiveCalls(data.calls.filter((c) => c.status === "IN_PROGRESS"));
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEventStream(
    useCallback(
      (event: DashboardEvent) => {
        // call.transcript is per-turn chatter, not a status change - LiveCallTranscript
        // (mounted per expanded row) already reacts to it directly, so reloading the
        // in-progress-calls list here would just be a redundant refetch per utterance.
        if (event.type.startsWith("call.") && event.type !== "call.transcript") load();
      },
      [load]
    )
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="size-4" />
          Live calls
        </CardTitle>
        <CardDescription>Calls in progress right now — expand one to watch its transcript live.</CardDescription>
      </CardHeader>
      <CardContent>
        {liveCalls === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {liveCalls !== null && liveCalls.length === 0 && (
          <p className="text-sm text-muted-foreground">No calls in progress.</p>
        )}
        {liveCalls !== null && liveCalls.length > 0 && (
          <div className="flex flex-col gap-2">
            {liveCalls.map((call) => (
              <LiveCallRow
                key={call.id}
                call={call}
                expanded={expandedId === call.id}
                onToggle={() => setExpandedId((prev) => (prev === call.id ? null : call.id))}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
