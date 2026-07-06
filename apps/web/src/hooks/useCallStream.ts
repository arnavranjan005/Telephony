"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/apiClient";

export type CallStreamStatus = "connecting" | "open" | "closed";

export interface CallStreamEvent {
  type: string;
  callId: string | null;
  data: unknown;
  timestamp: string;
}

/**
 * Subscribes to the per-call SSE feed (GET /api/calls/:callId/events) -
 * call.answered/call.transcript/call.hangup/conversation.message events
 * scoped to one call, published by callConversationService.ts and
 * callStreamSession.ts as the call actually happens. Pass a falsy callId to
 * stay disconnected (e.g. nothing selected, or the call already ended).
 */
export function useCallStream(callId: string | null | undefined, onEvent?: (event: CallStreamEvent) => void) {
  const [status, setStatus] = useState<CallStreamStatus>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!callId) {
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    const source = new EventSource(`${API_URL}/api/calls/${callId}/events`);

    source.addEventListener("connected", () => setStatus("open"));
    source.onerror = () => setStatus((prev) => (prev === "open" ? "connecting" : prev));

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as CallStreamEvent;
        onEventRef.current?.(parsed);
      } catch {
        // ignore malformed events
      }
    };

    const eventTypes = ["call.answered", "call.transcript", "call.hangup", "conversation.message"];
    eventTypes.forEach((type) => source.addEventListener(type, handleMessage));

    return () => {
      source.close();
      setStatus("closed");
    };
  }, [callId]);

  return status;
}
