"use client";

import { useEffect, useState } from "react";

/** Ticking elapsed-seconds-since counter, for showing a live call's running duration. */
export function useElapsedSeconds(since: string | null | undefined): number | null {
  const [elapsed, setElapsed] = useState<number | null>(
    since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)) : null
  );

  useEffect(() => {
    if (!since) {
      setElapsed(null);
      return;
    }
    const startedAtMs = new Date(since).getTime();
    setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));

    const interval = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    }, 1000);

    return () => clearInterval(interval);
  }, [since]);

  return elapsed;
}
