import { Request, Response } from "express";
import { z } from "zod";
import { prisma, LeadStatus, ConsentStatus, Prisma } from "@telephony/database";
import { recordConsent, revokeConsent } from "@telephony/domain";
import { callEventBus } from "../sse/eventBus";

const createLeadSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z.string().min(1),
  email: z.string().email().optional(),
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().optional(),
  /** Grants TCPA consent as part of creation (single atomic write) rather
   * than a separate follow-up call to the consent endpoint. */
  consentGranted: z.boolean().optional(),
});

export async function createLead(req: Request, res: Response) {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { consentGranted, ...fields } = parsed.data;

  try {
    const lead = await prisma.lead.create({
      data: {
        ...fields,
        ...(consentGranted
          ? { consentStatus: ConsentStatus.GRANTED, consentSource: "admin_panel", consentedAt: new Date() }
          : {}),
      },
    });
    callEventBus.publishGlobal("lead.created", { lead });
    res.status(201).json({ lead });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ error: "A lead with this phone number already exists" });
    }
    throw error;
  }
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

// consentGranted is create-only sugar: it is not a Lead column, so passing it
// through to prisma.lead.update() throws an unknown-argument error (a 500 for
// the client). Consent changes on an existing lead go through the dedicated
// POST /:leadId/consent endpoint, which also sets consentedAt server-side.
const updateLeadSchema = createLeadSchema.partial().omit({ phoneNumber: true, consentGranted: true }).extend({
  phoneNumber: z.string().min(1).optional(),
});

export async function updateLead(req: Request, res: Response) {
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const lead = await prisma.lead.update({ where: { id: req.params.leadId }, data: parsed.data });
  callEventBus.publishGlobal("lead.updated", { lead });
  res.json({ lead });
}

const setConsentSchema = z.object({
  granted: z.boolean(),
  source: z.string().optional(),
});

/**
 * Records (or revokes) TCPA consent for a lead - the gate automated
 * campaign/follow-up dialing checks before placing a call. Kept as its own
 * endpoint (rather than a plain PATCH field) so consentedAt is always set
 * server-side from the moment consent actually changes, not whatever value a
 * client happens to send.
 */
export async function setLeadConsent(req: Request, res: Response) {
  const parsed = setConsentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const lead = parsed.data.granted
    ? await recordConsent(req.params.leadId, parsed.data.source)
    : await revokeConsent(req.params.leadId);

  callEventBus.publishGlobal("lead.updated", { lead });
  res.json({ lead });
}

export async function deleteLead(req: Request, res: Response) {
  try {
    // deleteMany (not delete) so a repeat call on an already-deleted lead is a
    // no-op 204 instead of throwing "record not found" - DELETE should be
    // idempotent.
    await prisma.lead.deleteMany({ where: { id: req.params.leadId } });
  } catch (error) {
    // CampaignContact/FollowUp reference Lead with required (Restrict) FKs,
    // so a lead that's part of a campaign or has follow-ups can't be deleted.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return res.status(409).json({
        error: "This lead is referenced by a campaign or follow-up and can't be deleted",
      });
    }
    throw error;
  }
  res.status(204).send();
}
