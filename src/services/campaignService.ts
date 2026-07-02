import { CampaignContactStatus, CampaignStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { placeOutboundCall } from "./outboundDialService";
import { enqueueCampaignContactDial } from "../queues/dialQueue";

export interface CampaignContactInput {
  leadId?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
}

export interface CreateCampaignInput {
  name: string;
  script?: string;
  contacts: CampaignContactInput[];
}

/**
 * Creates a campaign and its contact list atomically: either every contact
 * (upserting leads by phone number where needed) is created alongside the
 * campaign, or none are - a failure partway through no longer leaves a
 * campaign with a partial contact list.
 */
export async function createCampaign(input: CreateCampaignInput) {
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({ data: { name: input.name, script: input.script } });

    for (const contact of input.contacts) {
      let leadId = contact.leadId;
      if (!leadId) {
        if (!contact.phoneNumber) continue;
        const lead = await tx.lead.upsert({
          where: { phoneNumber: contact.phoneNumber },
          update: {},
          create: { phoneNumber: contact.phoneNumber, firstName: contact.firstName, lastName: contact.lastName },
        });
        leadId = lead.id;
      }
      await tx.campaignContact.create({ data: { campaignId: created.id, leadId } });
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
    where: { campaignId: id, status: CampaignContactStatus.PENDING },
    select: { id: true },
  });
  await Promise.all(pendingContacts.map((contact) => enqueueCampaignContactDial(contact.id)));

  return campaign;
}

export async function pauseCampaign(id: string) {
  return prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.PAUSED } });
}

/**
 * Marks the campaign COMPLETED once it has no PENDING contacts left. Uses a
 * conditional update (only flips RUNNING -> COMPLETED) so redundant calls
 * from multiple concurrent job finalizers are harmless.
 */
async function completeCampaignIfExhausted(campaignId: string) {
  const remaining = await prisma.campaignContact.count({
    where: { campaignId, status: CampaignContactStatus.PENDING },
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
 * (PENDING -> CALLING via a conditional UPDATE) before dialing, so if two
 * workers race on the same row - or the reconciliation sweep re-enqueues a
 * row something else already claimed - only one of them actually dials.
 * Called by the worker; safe to call multiple times for the same id.
 */
export async function processCampaignContactJob(campaignContactId: string): Promise<void> {
  const claimed = await prisma.campaignContact.updateMany({
    where: { id: campaignContactId, status: CampaignContactStatus.PENDING },
    data: { status: CampaignContactStatus.CALLING, attemptedAt: new Date() },
  });
  if (claimed.count === 0) return; // already claimed or completed elsewhere

  const contact = await prisma.campaignContact.findUniqueOrThrow({
    where: { id: campaignContactId },
    include: { lead: true },
  });

  const result = await placeOutboundCall(contact.lead.phoneNumber, contact.leadId);

  if (result.outcome === "skipped_dnc") {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.SKIPPED_DNC },
    });
  } else if (result.outcome === "failed") {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { status: CampaignContactStatus.FAILED },
    });
  } else {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: { callId: result.callId },
    });
  }

  await completeCampaignIfExhausted(contact.campaignId);
}
