import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  // calls
  COMPLETED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  IN_PROGRESS: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  RINGING: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  QUEUED: "bg-muted text-muted-foreground",
  INITIATED: "bg-muted text-muted-foreground",
  FAILED: "bg-destructive/10 text-destructive",
  NO_ANSWER: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  BUSY: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  CANCELED: "bg-muted text-muted-foreground",
  // leads
  HOT: "bg-red-500/10 text-red-600 dark:text-red-400",
  WARM: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  COLD: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  // consent
  GRANTED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  REVOKED: "bg-destructive/10 text-destructive",
  UNKNOWN: "bg-muted text-muted-foreground",
  // campaigns
  DRAFT: "bg-muted text-muted-foreground",
  RUNNING: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  PAUSED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  // campaign contacts / follow-ups
  PENDING: "bg-muted text-muted-foreground",
  WAITING_FOR_CALLING_HOURS: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  CALLING: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  CALLED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  SKIPPED_DNC: "bg-destructive/10 text-destructive",
  SKIPPED_NO_CONSENT: "bg-destructive/10 text-destructive",
  // appointments
  SCHEDULED: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  CONFIRMED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-transparent font-medium", STATUS_STYLES[status], className)}>
      {status.replaceAll("_", " ")}
    </Badge>
  );
}
