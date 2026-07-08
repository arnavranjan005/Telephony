import { z } from "zod";
import type { Call } from "./call";
import type { Appointment } from "./appointment";

export const LeadStatusValues = ["COLD", "WARM", "HOT"] as const;
export type LeadStatus = (typeof LeadStatusValues)[number];

export const ConsentStatusValues = ["UNKNOWN", "GRANTED", "REVOKED"] as const;
export type ConsentStatus = (typeof ConsentStatusValues)[number];

export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string;
  email: string | null;
  status: LeadStatus;
  notes: string | null;
  consentStatus: ConsentStatus;
  consentSource: string | null;
  consentedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadWithDetails extends Lead {
  calls: Call[];
  appointments: Appointment[];
}

export const createLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z.string().min(1),
  email: z.string().email().optional(),
  status: z.enum(LeadStatusValues).optional(),
  notes: z.string().optional(),
  /** Grants TCPA consent as part of creation (single atomic write) rather
   * than a separate follow-up call to the consent endpoint. */
  consentGranted: z.boolean().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = createLeadSchema.partial().omit({ phoneNumber: true }).extend({
  phoneNumber: z.string().min(1).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const setLeadConsentSchema = z.object({
  granted: z.boolean(),
  source: z.string().optional(),
});
export type SetLeadConsentInput = z.infer<typeof setLeadConsentSchema>;
