"use client";

import { useEffect, useRef, useState } from "react";
import { useCallStream } from "@/hooks/useCallStream";
import { cn } from "@/lib/utils";

interface LiveTurn {
  key: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
}

const ROLE_STYLES: Record<LiveTurn["role"], string> = {
  user: "bg-muted",
  assistant: "bg-primary/10",
  system: "bg-transparent text-muted-foreground italic",
  tool: "bg-amber-500/10",
};

/**
 * Live-updating transcript for one in-progress call, subscribed directly to
 * its per-call SSE feed (GET /api/calls/:callId/events) rather than
 * polling REST - turns appear the instant callConversationService /
 * callStreamSession publish them, no refetch involved.
 */
export function LiveCallTranscript({ callId, onHangup }: { callId: string; onHangup?: () => void }) {
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [callerSpeaking, setCallerSpeaking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const status = useCallStream(callId, (event) => {
    if (event.type === "conversation.message") {
      const data = event.data as { role?: LiveTurn["role"]; content?: string; toolName?: string };
      if (!data.role || data.role === "system") return;
      setCallerSpeaking(false);
      setTurns((prev) => [
        ...prev,
        { key: `${event.timestamp}-${prev.length}`, role: data.role!, content: data.content ?? "", toolName: data.toolName },
      ]);
    } else if (event.type === "call.transcript") {
      // Legacy webhook flow: a final caller utterance arrived and is about to
      // be run through the agent - conversation.message will follow shortly.
      setCallerSpeaking(true);
    } else if (event.type === "call.hangup") {
      onHangup?.();
    }
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, callerSpeaking]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            status === "open" ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
          )}
        />
        {status === "open" ? "Live transcript" : "Connecting…"}
      </div>

      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
        {turns.length === 0 && !callerSpeaking && (
          <p className="text-sm text-muted-foreground">Waiting for the conversation to start…</p>
        )}
        {turns.map((turn) => (
          <div key={turn.key} className={cn("rounded-md px-3 py-2 text-sm", ROLE_STYLES[turn.role])}>
            <div className="mb-0.5 text-xs text-muted-foreground">
              <span className="font-medium">{turn.role}</span>
              {turn.toolName && <span> · {turn.toolName}</span>}
            </div>
            <p className="whitespace-pre-wrap break-words">{turn.content}</p>
          </div>
        ))}
        {callerSpeaking && (
          <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground italic">Caller is speaking…</div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
