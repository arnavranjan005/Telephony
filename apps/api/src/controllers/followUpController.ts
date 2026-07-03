import { Request, Response } from "express";
import { z } from "zod";
import { FollowUpStatus } from "@telephony/database";
import { cancelFollowUp, createFollowUp, listFollowUps } from "@telephony/domain";

const createFollowUpSchema = z.object({
  leadId: z.string().min(1),
  scheduledAt: z.string(),
  reason: z.string().optional(),
});

export async function postFollowUp(req: Request, res: Response) {
  const parsed = createFollowUpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const followUp = await createFollowUp({
    leadId: parsed.data.leadId,
    scheduledAt: new Date(parsed.data.scheduledAt),
    reason: parsed.data.reason,
  });

  res.status(201).json({ followUp });
}

export async function getFollowUps(req: Request, res: Response) {
  const status = req.query.status as FollowUpStatus | undefined;
  const followUps = await listFollowUps(status);
  res.json({ followUps });
}

export async function postCancelFollowUp(req: Request, res: Response) {
  const followUp = await cancelFollowUp(req.params.followUpId);
  res.json({ followUp });
}
