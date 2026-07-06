import { Request, Response } from "express";
import { z } from "zod";
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  startCampaign,
} from "@telephony/domain";
import { callEventBus } from "../sse/eventBus";
import { OBJECTION_HANDLING_BASELINE } from "../callConversationService";

const contactSchema = z.object({
  leadId: z.string().optional(),
  phoneNumber: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
  script: z.string().optional(),
  objectionPlaybook: z.string().optional(),
  streamingEnabled: z.boolean().optional(),
  contacts: z.array(contactSchema).default([]),
});

export async function postCampaign(req: Request, res: Response) {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const campaign = await createCampaign(parsed.data);
  callEventBus.publishGlobal("campaign.created", { campaign });
  res.status(201).json({ campaign });
}

/**
 * Read-only reference for whoever is writing a campaign's optional
 * `objectionPlaybook` - lets the admin panel show what's already handled by
 * default so they only add campaign-specific detail, instead of guessing at
 * or duplicating it.
 */
export async function getObjectionBaseline(_req: Request, res: Response) {
  res.json({ text: OBJECTION_HANDLING_BASELINE });
}

export async function getCampaigns(_req: Request, res: Response) {
  const campaigns = await listCampaigns();
  res.json({ campaigns });
}

export async function getCampaignById(req: Request, res: Response) {
  const campaign = await getCampaign(req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({ campaign });
}

export async function postStartCampaign(req: Request, res: Response) {
  const campaign = await startCampaign(req.params.campaignId);
  callEventBus.publishGlobal("campaign.updated", { campaign });
  res.json({ campaign });
}

export async function postPauseCampaign(req: Request, res: Response) {
  const campaign = await pauseCampaign(req.params.campaignId);
  callEventBus.publishGlobal("campaign.updated", { campaign });
  res.json({ campaign });
}
