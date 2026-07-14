import { CampaignContactStatus, CampaignStatus, ConsentStatus, prisma } from "@telephony/database";
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
 * Creates a campaign and its contact list atomically, in a handful of bulk
 * queries rather than a per-contact upsert loop - so importing a large CSV of
 * contacts doesn't fan out into thousands of sequential round-trips.
 *
 * Contacts arrive as either an existing `leadId` (picked from the lead list)
 * or a `phoneNumber` (imported/typed). Phone contacts are resolved to leads
 * in three steps: createMany new leads (skipping numbers already in the DB),
 * findMany to get ids for the whole set (new *and* pre-existing - so an
 * already-existing lead is linked, not duplicated or dropped), then createMany
 * the campaign contacts. Either the whole set lands or none does.
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

    // Split contacts and de-dupe phone contacts up front (keeping the first
    // occurrence's name), so a number that appears twice - or once as a
    // picked lead and once by phone - only ever becomes one contact.
    const directLeadIds = new Set<string>();
    const phoneContacts = new Map<string, { firstName?: string; lastName?: string }>();
    for (const contact of input.contacts) {
      if (contact.leadId) {
        directLeadIds.add(contact.leadId);
      } else if (contact.phoneNumber && !phoneContacts.has(contact.phoneNumber)) {
        phoneContacts.set(contact.phoneNumber, { firstName: contact.firstName, lastName: contact.lastName });
      }
    }

    // 1. Create the leads for new phone numbers in one insert; existing
    //    numbers (unique phoneNumber) are skipped, not errored.
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

    // 2. Resolve every phone number to a lead id - the ones just created and
    //    the ones that already existed.
    const resolved =
      phoneContacts.size > 0
        ? await tx.lead.findMany({
            where: { phoneNumber: { in: [...phoneContacts.keys()] } },
            select: { id: true },
          })
        : [];
    const leadIds = [...new Set([...directLeadIds, ...resolved.map((l) => l.id)])];

    // Consent (opt-in): campaigns only auto-dial GRANTED leads, so when the
    // toggle is on, grant consent to every lead in the campaign in one update -
    // including picked and pre-existing ones. Leave already-granted leads'
    // consentedAt untouched.
    if (input.consentGrantedAll && leadIds.length > 0) {
      await tx.lead.updateMany({
        where: { id: { in: leadIds }, consentStatus: { not: ConsentStatus.GRANTED } },
        data: { consentStatus: ConsentStatus.GRANTED, consentSource: "campaign", consentedAt: new Date() },
      });
    }

    // 3. Link them all to the campaign in one insert.
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
