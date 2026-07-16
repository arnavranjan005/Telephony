import { CampaignContactStatus, CampaignStatus, ConsentStatus, Prisma, prisma } from "@telephony/database";
import { enqueueCampaignContactDial, enqueueCampaignContactDialAt } from "@telephony/queue";
import { env } from "@telephony/config";
import { placeOutboundCall } from "./outboundDialService";
import { isWithinCallingHours, nextCallingWindowStart } from "./compliance/callingHours";

export interface CampaignContactInput {
  leadId?: string;
  phoneNumber?: string;
  name?: string;
}

export interface CreateCampaignInput {
  name: string;
  // Required: without one, the model has nothing concrete to open with and
  // falls back to improvising a generic sales pitch - observed live reading
  // unfilled template placeholders ("this is [Your Name] from [Your
  // Company]") straight into the call, since it has no real facts to use
  // instead.
  script: string;
  /** Product/offer-specific rebuttals for this campaign (e.g. "if price is
   * the objection, mention the 3-installment plan") - appended to the AI's
   * system prompt alongside `script`. Optional: the baseline system prompt
   * already handles objections generically, this only adds campaign-specific
   * factual detail on top. */
  objectionPlaybook?: string;
  /** Spoken verbatim the instant an outbound call for this campaign connects,
   * before the AI model is ever invoked (see callStreamSession.ts) - so the
   * callee hears something immediately instead of the AI silently waiting
   * for them to speak first. Optional: falls back to a generic default
   * (resolveGreeting in callConversationService.ts) when unset. */
  openingLine?: string;
  /** Every dial this campaign makes uses real-time media streaming (barge-in)
   * by default - see outboundDialService.ts's PlaceOutboundCallOptions. Pass
   * `false` to opt this campaign out. Still gated by the global
   * MEDIA_STREAM_ENABLED flag at dial time either way. */
  streamingEnabled?: boolean;
  contacts: CampaignContactInput[];
  /** Grants TCPA consent to every lead in this campaign (picked, imported, or
   * typed) at create time. Campaigns only auto-dial GRANTED leads, so without
   * this, contacts added by phone number land UNKNOWN and are silently
   * skipped when the campaign runs. */
  consentGrantedAll?: boolean;
}

/**
 * Resolves a mixed list of contacts (existing `leadId`s and/or `phoneNumber`s)
 * to a de-duplicated array of lead ids, in a handful of bulk queries rather
 * than a per-contact upsert loop - so importing a large CSV of contacts
 * doesn't fan out into thousands of sequential round-trips.
 *
 * Phone contacts are resolved in two steps: createMany new leads (skipping
 * numbers already in the DB), then findMany to get ids for the whole set (new
 * *and* pre-existing - so an already-existing lead is linked, not duplicated
 * or dropped). A number that appears twice - or once as a picked leadId and
 * once by phone - only ever resolves to one id.
 *
 * When `consentGrantedAll` is set, grants TCPA consent to every resolved lead
 * in one update (campaigns only auto-dial GRANTED leads), leaving already-
 * granted leads' consentedAt untouched.
 */
async function resolveContactLeadIds(
  tx: Prisma.TransactionClient,
  contacts: CampaignContactInput[],
  consentGrantedAll?: boolean
): Promise<string[]> {
  const directLeadIds = new Set<string>();
  const phoneContacts = new Map<string, { name?: string }>();
  for (const contact of contacts) {
    if (contact.leadId) {
      directLeadIds.add(contact.leadId);
    } else if (contact.phoneNumber && !phoneContacts.has(contact.phoneNumber)) {
      phoneContacts.set(contact.phoneNumber, { name: contact.name });
    }
  }

  if (phoneContacts.size > 0) {
    await tx.lead.createMany({
      data: [...phoneContacts].map(([phoneNumber, contact]) => ({
        phoneNumber,
        name: contact.name,
      })),
      skipDuplicates: true,
    });
  }

  const resolved =
    phoneContacts.size > 0
      ? await tx.lead.findMany({
          where: { phoneNumber: { in: [...phoneContacts.keys()] } },
          select: { id: true },
        })
      : [];
  const leadIds = [...new Set([...directLeadIds, ...resolved.map((l) => l.id)])];

  if (consentGrantedAll && leadIds.length > 0) {
    await tx.lead.updateMany({
      where: { id: { in: leadIds }, consentStatus: { not: ConsentStatus.GRANTED } },
      data: { consentStatus: ConsentStatus.GRANTED, consentSource: "campaign", consentedAt: new Date() },
    });
  }

  return leadIds;
}

/**
 * Creates a campaign and its contact list atomically - either the whole
 * contact set lands or none does.
 */
export async function createCampaign(input: CreateCampaignInput) {
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        name: input.name,
        script: input.script,
        objectionPlaybook: input.objectionPlaybook,
        openingLine: input.openingLine,
        streamingEnabled: input.streamingEnabled ?? true,
      },
    });

    const leadIds = await resolveContactLeadIds(tx, input.contacts, input.consentGrantedAll);

    if (leadIds.length > 0) {
      await tx.campaignContact.createMany({
        data: leadIds.map((leadId) => ({ campaignId: created.id, leadId })),
        skipDuplicates: true,
      });
    }

    return created;
  });

  return getCampaign(campaign.id);
}

/** Thrown by addContactsToCampaign when the target campaign has already left
 * DRAFT - once a campaign is dialing (or done), its contact list is no
 * longer something a plain "add more contacts" call can safely change. */
export class CampaignNotDraftError extends Error {
  constructor(status: string) {
    super(`Campaign is ${status}, not DRAFT - contacts can only be added to a campaign before it starts`);
    this.name = "CampaignNotDraftError";
  }
}

export interface AddCampaignContactsResult {
  campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>;
  /** New campaign-contact links created. */
  added: number;
  /** Resolved leads that already had a contact row in this campaign - the
   * @@unique([campaignId, leadId]) constraint makes createMany's
   * skipDuplicates skip these rather than erroring or double-linking. */
  alreadyInCampaign: number;
}

/**
 * Adds more contacts to an existing DRAFT campaign - e.g. from a lead CSV
 * import elsewhere in the app that the user wants attached to a campaign
 * they've already drafted, rather than re-picking those leads by hand.
 *
 * Restricted to DRAFT: a RUNNING/PAUSED campaign's contacts are mid dial-
 * queue, and appending to that queue live needs different handling (e.g.
 * immediately enqueuing dials) that this function doesn't attempt.
 *
 * Returns null if the campaign doesn't exist, so the caller can 404. Throws
 * CampaignNotDraftError if it exists but isn't DRAFT, so the caller can 409.
 */
export async function addContactsToCampaign(
  campaignId: string,
  contacts: CampaignContactInput[],
  consentGrantedAll?: boolean
): Promise<AddCampaignContactsResult | null> {
  const outcome = await prisma.$transaction(async (tx) => {
    // Atomically verify - and, for the rest of this transaction, hold via the
    // row lock this UPDATE takes - that the campaign is still DRAFT. A plain
    // read-then-branch here would leave a window where a concurrent
    // startCampaign() (a separate, unwrapped update + "enqueue every PENDING
    // contact" read) could run between the check and the contacts actually
    // landing: it would flip status to RUNNING and read pending contacts
    // without ever seeing the ones this call is about to insert, stranding
    // them as PENDING on a RUNNING campaign until some future restart. This
    // conditional updateMany mirrors completeCampaignIfExhausted's atomic
    // status flip above - the same idiom applied to a status *gate* instead
    // of a status *transition*: startCampaign's own update to the same row
    // has to wait for this transaction to finish, so it can only run either
    // fully before this claim (and this call then correctly sees non-DRAFT)
    // or fully after this transaction commits (and its contact query then
    // sees the new contacts already inserted).
    const claimed = await tx.campaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.DRAFT },
      data: { updatedAt: new Date() },
    });
    if (claimed.count === 0) {
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) return null;
      throw new CampaignNotDraftError(campaign.status);
    }

    const leadIds = await resolveContactLeadIds(tx, contacts, consentGrantedAll);
    if (leadIds.length === 0) return { added: 0, alreadyInCampaign: 0 };

    const { count } = await tx.campaignContact.createMany({
      data: leadIds.map((leadId) => ({ campaignId, leadId })),
      skipDuplicates: true,
    });
    return { added: count, alreadyInCampaign: leadIds.length - count };
  });

  if (!outcome) return null;
  const campaign = await getCampaign(campaignId);
  return { campaign: campaign!, added: outcome.added, alreadyInCampaign: outcome.alreadyInCampaign };
}

export interface SkippedLead {
  id: string;
  name: string | null;
  phoneNumber: string;
  /** Human-readable summary of why this lead couldn't be deleted, e.g.
   * "2 calls, in 1 other campaign". */
  reason: string;
}

export interface DeleteCampaignLeadsResult {
  campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>;
  /** Leads actually deleted. */
  deleted: number;
  /** Leads left untouched - either attached to another campaign too, or with
   * call/appointment/follow-up history - and why each was skipped. */
  skipped: number;
  skippedLeads: SkippedLead[];
}

/** Builds the human-readable reason a lead was skipped from its related-row
 * counts - a lead can have more than one reason at once (e.g. call history
 * *and* another campaign), so this joins whichever apply. */
function describeSkipReason(counts: { calls: number; appointments: number; followUps: number; campaignContacts: number }): string {
  const parts: string[] = [];
  if (counts.calls > 0) parts.push(`${counts.calls} call${counts.calls === 1 ? "" : "s"}`);
  if (counts.appointments > 0) parts.push(`${counts.appointments} appointment${counts.appointments === 1 ? "" : "s"}`);
  if (counts.followUps > 0) parts.push(`${counts.followUps} follow-up${counts.followUps === 1 ? "" : "s"}`);
  // campaignContacts includes this campaign's own row, so subtract it to get
  // the count of *other* campaigns this lead is attached to.
  const otherCampaigns = counts.campaignContacts - 1;
  if (otherCampaigns > 0) parts.push(`in ${otherCampaigns} other campaign${otherCampaigns === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * Permanently deletes every lead attached to a DRAFT campaign - e.g. cleaning
 * up a throwaway import or a campaign that was drafted by mistake - rather
 * than just detaching them (which addContactsToCampaign's inverse would do).
 *
 * Only deletes a lead if it's "clean": no calls, appointments, or follow-ups,
 * and this campaign is the only one it's attached to. Postgres itself would
 * reject deleting a lead that still has any of those (no cascade is
 * configured on those relations on purpose - see schema.prisma), but the
 * check happens up front so a lead with real history is silently left alone
 * instead of the whole batch erroring out. A lead skipped this way keeps its
 * contact row on this campaign too, since deleting the attachment but not
 * the lead would just be a confusing partial no-op.
 *
 * Restricted to DRAFT for the same reason as addContactsToCampaign: a
 * RUNNING/PAUSED campaign's contacts are mid dial-queue, and deleting leads
 * out from under an active dial needs different handling this doesn't
 * attempt.
 *
 * Returns null if the campaign doesn't exist, so the caller can 404. Throws
 * CampaignNotDraftError if it exists but isn't DRAFT, so the caller can 409.
 */
export async function deleteCampaignLeads(campaignId: string): Promise<DeleteCampaignLeadsResult | null> {
  const outcome = await prisma.$transaction(async (tx) => {
    // Same atomic DRAFT claim as addContactsToCampaign above - without it, a
    // concurrent startCampaign() could enqueue dials for leads this
    // transaction is about to delete.
    const claimed = await tx.campaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.DRAFT },
      data: { updatedAt: new Date() },
    });
    if (claimed.count === 0) {
      const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) return null;
      throw new CampaignNotDraftError(campaign.status);
    }

    const contacts = await tx.campaignContact.findMany({ where: { campaignId }, select: { leadId: true } });
    const leadIds = contacts.map((c) => c.leadId);
    if (leadIds.length === 0) return { deleted: 0, skipped: 0, skippedLeads: [] as SkippedLead[] };

    const leads = await tx.lead.findMany({
      where: { id: { in: leadIds } },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        _count: { select: { calls: true, appointments: true, followUps: true, campaignContacts: true } },
      },
    });

    // campaignContacts === 1 means this campaign is the only one it's in -
    // every lead here has at least this one contact row, so 1 is "none else".
    const isClean = (counts: { calls: number; appointments: number; followUps: number; campaignContacts: number }) =>
      counts.calls === 0 && counts.appointments === 0 && counts.followUps === 0 && counts.campaignContacts === 1;

    const cleanLeadIds = leads.filter((lead) => isClean(lead._count)).map((lead) => lead.id);
    const skippedLeads: SkippedLead[] = leads
      .filter((lead) => !isClean(lead._count))
      .map((lead) => ({
        id: lead.id,
        name: lead.name,
        phoneNumber: lead.phoneNumber,
        reason: describeSkipReason(lead._count),
      }));

    let deleted = 0;
    if (cleanLeadIds.length > 0) {
      // Both deletes re-verify cleanliness live rather than trusting the
      // _count read above: this campaign's own claim only locks *this*
      // campaign's row, so a concurrent addContactsToCampaign() on a
      // DIFFERENT draft campaign could attach one of these leads (or a call/
      // appointment/follow-up could land on it) in the window between that
      // read and these deletes.
      //
      // The contact-row delete is gated on the SAME liveness check, not just
      // membership in cleanLeadIds - otherwise a lead that raced in a new
      // disqualifying row would still have its contact row on this campaign
      // removed unconditionally here, leaving it silently detached from a
      // campaign it's supposedly just "skipped" (untouched) from, even
      // though it never actually gets deleted below. Gating this delete the
      // same way means a lead's contact row is only ever removed at a moment
      // it's genuinely clean and solely attached to this campaign - correct
      // regardless of what happens to it a moment later.
      const liveCleanFilter = { calls: { none: {} }, appointments: { none: {} }, followUps: { none: {} } };
      await tx.campaignContact.deleteMany({
        where: {
          campaignId,
          leadId: { in: cleanLeadIds },
          lead: { ...liveCleanFilter, campaignContacts: { none: { campaignId: { not: campaignId } } } },
        },
      });

      // Anything whose contact row was just removed above now has zero
      // campaignContacts left (that was its only one) and is safe to delete;
      // anything still holding a contact row - raced, or unclean all along -
      // is correctly excluded rather than hitting its still-live FK.
      const result = await tx.lead.deleteMany({
        where: { id: { in: cleanLeadIds }, ...liveCleanFilter, campaignContacts: { none: {} } },
      });
      deleted = result.count;
    }

    return { deleted, skipped: leadIds.length - deleted, skippedLeads };
  });

  if (!outcome) return null;
  const campaign = await getCampaign(campaignId);
  return {
    campaign: campaign!,
    deleted: outcome.deleted,
    skipped: outcome.skipped,
    skippedLeads: outcome.skippedLeads,
  };
}

export async function listCampaigns() {
  return prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getCampaign(id: string) {
  return prisma.campaign.findUnique({
    where: { id },
    include: { contacts: { include: { lead: true } } },
  });
}

export async function startCampaign(id: string) {
  const campaign = await prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.RUNNING } });

  const pendingContacts = await prisma.campaignContact.findMany({
    where: {
      campaignId: id,
      status: { in: [CampaignContactStatus.PENDING, CampaignContactStatus.WAITING_FOR_CALLING_HOURS] },
    },
    select: { id: true },
  });
  await Promise.all(pendingContacts.map((contact) => enqueueCampaignContactDial(contact.id)));

  return campaign;
}

export async function pauseCampaign(id: string) {
  return prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.PAUSED } });
}

/**
 * Marks the campaign COMPLETED once it has no PENDING (or still-waiting-on-
 * calling-hours) contacts left. Uses a conditional update (only flips
 * RUNNING -> COMPLETED) so redundant calls from multiple concurrent job
 * finalizers are harmless.
 */
async function completeCampaignIfExhausted(campaignId: string) {
  const remaining = await prisma.campaignContact.count({
    where: {
      campaignId,
      status: { in: [CampaignContactStatus.PENDING, CampaignContactStatus.WAITING_FOR_CALLING_HOURS] },
    },
  });
  if (remaining === 0) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: CampaignStatus.RUNNING },
      data: { status: CampaignStatus.COMPLETED },
    });
  }
}

/**
 * Processes one campaign-contact dial job. Atomically claims the row
 * (PENDING/WAITING_FOR_CALLING_HOURS -> CALLING via a conditional UPDATE)
 * before dialing, so if two workers race on the same row - or the
 * reconciliation sweep re-enqueues a row something else already claimed -
 * only one of them actually dials. The claim also requires the campaign to
 * still be RUNNING, so pausing a campaign actually stops its still-queued
 * contacts from being dialed instead of just relabeling the campaign row -
 * they stay claimable and get picked up again the next time the campaign is
 * started.
 * Called by the worker; safe to call multiple times for the same id.
 */
export async function processCampaignContactJob(campaignContactId: string): Promise<void> {
  const claimed = await prisma.campaignContact.updateMany({
    where: {
      id: campaignContactId,
      status: { in: [CampaignContactStatus.PENDING, CampaignContactStatus.WAITING_FOR_CALLING_HOURS] },
      campaign: { status: CampaignStatus.RUNNING },
    },
    data: { status: CampaignContactStatus.CALLING, attemptedAt: new Date() },
  });
  if (claimed.count === 0) return; // already claimed/completed elsewhere, or campaign isn't RUNNING

  const contact = await prisma.campaignContact.findUniqueOrThrow({
    where: { id: campaignContactId },
    include: { lead: true, campaign: true },
  });

  // TCPA calling-hours (8am-9pm local to the number) is a *when*, not a
  // *whether* - give the claim back instead of finalizing a terminal status,
  // and reschedule for the next legal window rather than dropping the
  // contact. Distinct from PENDING so the admin panel can show this contact
  // is genuinely waiting on its calling window, not just never attempted.
  if (!isWithinCallingHours(contact.lead.phoneNumber)) {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.WAITING_FOR_CALLING_HOURS },
    });
    await enqueueCampaignContactDialAt(campaignContactId, nextCallingWindowStart(contact.lead.phoneNumber));
    return;
  }

  const result = await placeOutboundCall(contact.lead.phoneNumber, contact.leadId, {
    requireConsent: true,
    streamingEnabled: Boolean(contact.campaign.streamingEnabled) && env.MEDIA_STREAM_ENABLED,
  });

  if (result.outcome === "skipped_dnc") {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.SKIPPED_DNC },
    });
  } else if (result.outcome === "skipped_no_consent") {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.SKIPPED_NO_CONSENT },
    });
  } else if (result.outcome === "failed") {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.FAILED, callId: result.callId },
    });
  } else {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { callId: result.callId },
    });
  }

  await completeCampaignIfExhausted(contact.campaignId);
}
