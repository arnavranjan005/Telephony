"use client";

import { useEffect, useRef, useState } from "react";
import type { DashboardEvent } from "@telephony/shared-types";
import { API_URL } from "@/lib/apiClient";

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Subscribes to the dashboard-wide SSE feed (GET /api/events/stream) and
 * invokes onEvent for every event delivered - call/lead/campaign/
 * appointment/follow-up/DNC lifecycle events, dashboard-wide (not scoped to
 * one call). Reconnects automatically (the browser's native EventSource
 * behavior) if the connection drops.
 */
export function useEventStream(onEvent?: (event: DashboardEvent) => void) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/events/stream`);

    source.addEventListener("connected", () => setStatus("open"));
    source.onerror = () => setStatus((prev) => (prev === "open" ? "connecting" : prev));

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as DashboardEvent;
        onEventRef.current?.(parsed);
      } catch {
        // ignore malformed events
      }
    };

    // Named SSE events (event: call.hangup, etc.) don't hit onmessage - the
    // server always sets `event: <type>`, so we listen generically by
    // re-registering a catch-all listener per known type isn't feasible;
    // instead we listen on every event name we might receive via the
    // built-in "message" fallback for unnamed events, and addEventListener
    // for the ones the server actually emits.
    const eventTypes = [
      "call.created",
      "call.answered",
      "call.transcript",
      "call.hangup",
      "conversation.message",
      "lead.created",
      "lead.updated",
      "campaign.created",
      "campaign.updated",
      "appointment.created",
      "appointment.canceled",
      "followup.created",
      "followup.canceled",
      "dnc.added",
      "dnc.removed",
    ];
    eventTypes.forEach((type) => source.addEventListener(type, handleMessage));
    source.onmessage = handleMessage;

    return () => {
      source.close();
      setStatus("closed");
    };
  }, []);

  return status;
}
