import { Request, Response } from "express";
import { z } from "zod";
import { prisma, LeadStatus, ConsentStatus, Prisma } from "@telephony/database";
import { recordConsent, revokeConsent } from "@telephony/domain";
import {
  bulkCreateLeadsSchema,
  LEADS_PAGE_SIZE,
  LEADS_PAGE_SIZE_MAX,
  type BulkCreateLeadRow,
  type BulkImportResult,
} from "@telephony/shared-types";
import { callEventBus } from "../sse/eventBus";

const createLeadSchema = z.object({
  name: z.string().optional(),
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

/**
 * Bulk-imports leads from a CSV that the admin panel has already parsed into
 * a JSON array. The whole file is one request and one INSERT (createMany),
 * not one call per row.
 *
 * `consentGrantedAll` is the batch consent toggle: when set, every row is
 * written with GRANTED consent in the same insert (consent is set at create
 * time, never a follow-up update) - mirroring the single-lead createLead
 * flow above, just applied to the whole batch.
 *
 * Duplicate phone numbers never abort the import: collisions with an existing
 * lead are skipped via createMany's skipDuplicates, and collisions *within*
 * the uploaded file are de-duped up front. The response reports exact counts
 * so the admin panel can show "X imported, Y duplicates skipped".
 */
export async function bulkCreateLeads(req: Request, res: Response) {
  const parsed = bulkCreateLeadsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { leads, consentGrantedAll } = parsed.data;

  // De-dupe within the file first: createMany's skipDuplicates only guards
  // against rows already in the DB, and Postgres rejects the whole statement
  // if a single INSERT carries two rows with the same unique phoneNumber.
  // Keep the first occurrence of each number.
  const seen = new Set<string>();
  const uniqueRows = leads.filter((lead: BulkCreateLeadRow) => {
    if (seen.has(lead.phoneNumber)) return false;
    seen.add(lead.phoneNumber);
    return true;
  });
  const duplicatesInFile = leads.length - uniqueRows.length;

  const consentFields = consentGrantedAll
    ? { consentStatus: ConsentStatus.GRANTED, consentSource: "admin_panel", consentedAt: new Date() }
    : {};

  const { count } = await prisma.lead.createMany({
    data: uniqueRows.map((lead: BulkCreateLeadRow) => ({ ...lead, ...consentFields })),
    skipDuplicates: true,
  });

  const result: BulkImportResult = {
    created: count,
    skippedDuplicates: uniqueRows.length - count,
    duplicatesInFile,
  };

  // One dashboard-wide event for the whole batch (open lead pages reload on
  // any lead.* event) instead of one per created row.
  callEventBus.publishGlobal("lead.bulk_imported", result);
  res.status(201).json(result);
}

export async function listLeads(req: Request, res: Response) {
  const status = req.query.status as LeadStatus | undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;

  // Clamp the requested page size to a sane range; ignore garbage input.
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), LEADS_PAGE_SIZE_MAX)
    : LEADS_PAGE_SIZE;

  // Search matches name or phone so the lead picker can find any lead across
  // the whole table (not just a preloaded page). OR across name/phoneNumber,
  // case-insensitive contains; combined with the status filter.
  const where: Prisma.LeadWhereInput = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { phoneNumber: { contains: search } },
          ],
        }
      : {}),
  };

  // Cursor pagination: order by (createdAt desc, id desc) so the sort is
  // total even when several leads share a createdAt, then fetch one extra row
  // to tell whether another page exists. Bulk imports write many leads with
  // near-identical timestamps, so the id tie-breaker is what keeps paging from
  // skipping or repeating rows.
  const rows = await prisma.lead.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const leads = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? leads[leads.length - 1].id : null;

  res.json({ leads, nextCursor });
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
  // deleteMany (not delete) so a repeat call on an already-deleted lead is a
  // no-op 204 instead of throwing "record not found" - DELETE should be
  // idempotent.
  await prisma.lead.deleteMany({ where: { id: req.params.leadId } });
  res.status(204).send();
}
