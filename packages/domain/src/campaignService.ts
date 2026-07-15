import { CampaignContactStatus, CampaignStatus, ConsentStatus, Prisma, prisma } from "@telephony/database";
import { enqueueCampaignContactDial, enqueueCampaignContactDialAt } from "@telephony/queue";
import { env } from "@telephony/config";
import { placeOutboundCall } from "./outboundDialService";
import { isWithinCallingHours, nextCallingWindowStart } from "./compliance/callingHours";

export interface CampaignContactInput {
  leadId?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
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
  const phoneContacts = new Map<string, { firstName?: string; lastName?: string }>();
  for (const contact of contacts) {
    if (contact.leadId) {
      directLeadIds.add(contact.leadId);
    } else if (contact.phoneNumber && !phoneContacts.has(contact.phoneNumber)) {
      phoneContacts.set(contact.phoneNumber, { firstName: contact.firstName, lastName: contact.lastName });
    }
  }

  if (phoneContacts.size > 0) {
    await tx.lead.createMany({
      data: [...phoneContacts].map(([phoneNumber, name]) => ({
        phoneNumber,
        firstName: name.firstName,
        lastName: name.lastName,
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
    const campaign = await tx.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return null;
    if (campaign.status !== CampaignStatus.DRAFT) throw new CampaignNotDraftError(campaign.status);

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
