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

/** Hard cap on rows per bulk import - keeps a single request/insert bounded
 * and, together with the raised JSON body limit on the /bulk route, means a
 * pasted 100k-row file is rejected up front instead of stalling the API. */
export const BULK_IMPORT_MAX_ROWS = 2000;

/** Each row reuses the exact single-lead create shape (so column validation
 * stays identical), minus the per-row consentGranted flag - consent for a
 * bulk import is an all-or-nothing batch decision (consentGrantedAll) taken
 * in the import dialog before the upload starts. */
export const bulkCreateLeadSchema = createLeadSchema.omit({ consentGranted: true });
export type BulkCreateLeadRow = z.infer<typeof bulkCreateLeadSchema>;

export const bulkCreateLeadsSchema = z.object({
  leads: z.array(bulkCreateLeadSchema).min(1).max(BULK_IMPORT_MAX_ROWS),
  /** When true, every imported lead is written GRANTED in the same insert -
   * consent is set at create time, not via a follow-up update. */
  consentGrantedAll: z.boolean().optional(),
});
export type BulkCreateLeadsInput = z.infer<typeof bulkCreateLeadsSchema>;

export interface BulkImportResult {
  /** Rows actually inserted. */
  created: number;
  /** Rows skipped because their phone number already existed (unique). */
  skippedDuplicates: number;
  /** Rows dropped inside the request body because their phone number
   * collided with another row in the same file. */
  duplicatesInFile: number;
}
