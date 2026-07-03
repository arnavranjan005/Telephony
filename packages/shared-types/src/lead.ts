import { z } from "zod";

export const LeadStatusValues = ["COLD", "WARM", "HOT"] as const;
export type LeadStatus = (typeof LeadStatusValues)[number];

export interface Lead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string;
  email: string | null;
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const createLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z.string().min(1),
  email: z.string().email().optional(),
  status: z.enum(LeadStatusValues).optional(),
  notes: z.string().optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = createLeadSchema.partial().omit({ phoneNumber: true }).extend({
  phoneNumber: z.string().min(1).optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
