"use client";

import { Phone, PhoneIncoming, CalendarCheck, CalendarX, Megaphone, UserPlus, PhoneCall, ShieldBan } from "lucide-react";
import type { DashboardEvent } from "@telephony/shared-types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const EVENT_META: Record<string, { icon: typeof Phone; label: string; color: string }> = {
  "call.created": { icon: Phone, label: "New call", color: "text-blue-500" },
  "call.answered": { icon: PhoneIncoming, label: "Call answered", color: "text-blue-500" },
  "call.hangup": { icon: Phone, label: "Call ended", color: "text-muted-foreground" },
  "lead.created": { icon: UserPlus, label: "New lead", color: "text-sky-500" },
  "lead.updated": { icon: UserPlus, label: "Lead updated", color: "text-sky-500" },
  "lead.bulk_imported": { icon: UserPlus, label: "Leads imported", color: "text-sky-500" },
  "campaign.created": { icon: Megaphone, label: "Campaign created", color: "text-violet-500" },
  "campaign.updated": { icon: Megaphone, label: "Campaign updated", color: "text-violet-500" },
  "appointment.created": { icon: CalendarCheck, label: "Appointment booked", color: "text-emerald-500" },
  "appointment.canceled": { icon: CalendarX, label: "Appointment canceled", color: "text-destructive" },
  "followup.created": { icon: PhoneCall, label: "Follow-up scheduled", color: "text-amber-500" },
  "followup.canceled": { icon: PhoneCall, label: "Follow-up canceled", color: "text-muted-foreground" },
  "dnc.added": { icon: ShieldBan, label: "Added to DNC", color: "text-destructive" },
  "dnc.removed": { icon: ShieldBan, label: "Removed from DNC", color: "text-muted-foreground" },
};

function describe(event: DashboardEvent): string {
  const data = event.data as Record<string, unknown> | null;
  if (!data) return "";

  const lead = data.lead as { name?: string; phoneNumber?: string } | undefined;
  const call = data.call as { fromNumber?: string; toNumber?: string } | undefined;
  const campaign = data.campaign as { name?: string; status?: string } | undefined;
  const appointment = data.appointment as { title?: string; startTime?: string } | undefined;
  const followUp = data.followUp as { scheduledAt?: string } | undefined;
  const entry = data.entry as { phoneNumber?: string } | undefined;

  if (typeof data.created === "number") {
    // Bulk import summary ({ created, skippedDuplicates, duplicatesInFile }).
    const skipped = (Number(data.skippedDuplicates) || 0) + (Number(data.duplicatesInFile) || 0);
    return `${data.created} imported${skipped > 0 ? `, ${skipped} skipped` : ""}`;
  }
  if (lead) return lead.name || lead.phoneNumber || "";
  if (call) return call.fromNumber ? `${call.fromNumber} → ${call.toNumber}` : "";
  if (campaign) return `${campaign.name}${campaign.status ? ` (${campaign.status})` : ""}`;
  if (appointment) return appointment.title ?? "";
  if (followUp?.scheduledAt) return `at ${new Date(followUp.scheduledAt).toLocaleString()}`;
  if (entry?.phoneNumber) return entry.phoneNumber;
  if (typeof data.phoneNumber === "string") return data.phoneNumber;
  if (typeof data.status === "string") return data.status;
  return "";
}

export function ActivityFeed({ events }: { events: DashboardEvent[] }) {
  if (events.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Waiting for live activity…</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {events.map((event, i) => {
        const meta = EVENT_META[event.type] ?? { icon: Phone, label: event.type, color: "text-muted-foreground" };
        const Icon = meta.icon;
        return (
          <li key={`${event.timestamp}-${i}`} className="flex items-start gap-3 text-sm">
            <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted", meta.color)}>
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{meta.label}</p>
              <p className="truncate text-muted-foreground">{describe(event)}</p>
            </div>
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">{relativeTime(event.timestamp)}</span>
          </li>
        );
      })}
    </ul>
  );
}
