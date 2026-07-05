"use client";

import { useEventStream } from "@/hooks/useEventStream";
import { cn } from "@/lib/utils";

export function LiveIndicator() {
  const status = useEventStream();

  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting…" : "Disconnected";
  const dotColor = status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-destructive";

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", dotColor, status === "open" && "animate-pulse")} />
      {label}
    </div>
  );
}
