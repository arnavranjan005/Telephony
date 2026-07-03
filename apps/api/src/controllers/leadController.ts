import { Request, Response } from "express";
import { z } from "zod";
import { prisma, LeadStatus } from "@telephony/database";

const createLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z.string().min(1),
  email: z.string().email().optional(),
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().optional(),
});

export async function createLead(req: Request, res: Response) {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const lead = await prisma.lead.create({ data: parsed.data });
  res.status(201).json({ lead });
}

export async function listLeads(req: Request, res: Response) {
  const status = req.query.status as LeadStatus | undefined;
  const leads = await prisma.lead.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json({ leads });
}

export async function getLead(req: Request, res: Response) {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.leadId },
    include: { calls: true, appointments: true },
  });
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json({ lead });
}

const updateLeadSchema = createLeadSchema.partial().omit({ phoneNumber: true }).extend({
  phoneNumber: z.string().min(1).optional(),
});

export async function updateLead(req: Request, res: Response) {
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const lead = await prisma.lead.update({ where: { id: req.params.leadId }, data: parsed.data });
  res.json({ lead });
}

export async function deleteLead(req: Request, res: Response) {
  // deleteMany (not delete) so a repeat call on an already-deleted lead is a
  // no-op 204 instead of throwing "record not found" - DELETE should be
  // idempotent.
  await prisma.lead.deleteMany({ where: { id: req.params.leadId } });
  res.status(204).send();
}
