import { CampaignContactStatus, CampaignStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { placeOutboundCall } from "./outboundDialService";

const DEFAULT_DISPATCH_LIMIT = 5;

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
 * Creates a campaign and its contact list, upserting leads by phone number
 * for contacts that aren't already an existing lead.
 */
export async function createCampaign(input: CreateCampaignInput) {
  const campaign = await prisma.campaign.create({ data: { name: input.name, script: input.script } });

  for (const contact of input.contacts) {
    let leadId = contact.leadId;
    if (!leadId) {
      if (!contact.phoneNumber) continue;
      const lead = await prisma.lead.upsert({
        where: { phoneNumber: contact.phoneNumber },
        update: {},
        create: { phoneNumber: contact.phoneNumber, firstName: contact.firstName, lastName: contact.lastName },
      });
      leadId = lead.id;
    }
    await prisma.campaignContact.create({ data: { campaignId: campaign.id, leadId } });
  }

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
  return prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.RUNNING } });
}

export async function pauseCampaign(id: string) {
  return prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.PAUSED } });
}

/**
 * Dials up to `limit` pending contacts across all RUNNING campaigns, and
 * marks a campaign COMPLETED once it has no PENDING contacts left. Intended
 * to be invoked periodically by the scheduler service.
 */
export async function dispatchNextCampaignContacts(limit: number = DEFAULT_DISPATCH_LIMIT): Promise<number> {
  const runningCampaigns = await prisma.campaign.findMany({ where: { status: CampaignStatus.RUNNING } });

  let dispatched = 0;
  for (const campaign of runningCampaigns) {
    if (dispatched >= limit) break;

    const pendingContacts = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id, status: CampaignContactStatus.PENDING },
      take: limit - dispatched,
      include: { lead: true },
    });

    if (pendingContacts.length === 0) {
      await prisma.campaign.update({ where: { id: campaign.id }, data: { status: CampaignStatus.COMPLETED } });
      continue;
    }

    for (const contact of pendingContacts) {
      const result = await placeOutboundCall(contact.lead.phoneNumber, contact.leadId);

      if (result.outcome === "skipped_dnc") {
        await prisma.campaignContact.update({
          where: { id: contact.id },
          data: { status: CampaignContactStatus.SKIPPED_DNC, attemptedAt: new Date() },
        });
        continue;
      }
      if (result.outcome === "failed") {
        await prisma.campaignContact.update({
          where: { id: contact.id },
          data: { status: CampaignContactStatus.FAILED, attemptedAt: new Date() },
        });
        continue;
      }

      await prisma.campaignContact.update({
        where: { id: contact.id },
        data: { status: CampaignContactStatus.CALLING, callId: result.callId, attemptedAt: new Date() },
      });
      dispatched += 1;
    }
  }

  return dispatched;
}
