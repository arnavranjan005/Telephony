import { Request, Response } from "express";
import { z } from "zod";
import { FollowUpStatus } from "@telephony/database";
import { cancelFollowUp, createFollowUp, listFollowUps } from "@telephony/domain";
import { callEventBus } from "../sse/eventBus";

const createFollowUpSchema = z.object({
  leadId: z.string().min(1),
  // Any string parseable as a date, not just z.string().datetime()'s strict
  // ISO subset - but an unparseable one must be a 400, not an Invalid Date
  // handed to Prisma (which throws, surfacing as a 500).
  scheduledAt: z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "scheduledAt must be a valid ISO 8601 datetime",
  }),
  reason: z.string().optional(),
  streamingEnabled: z.boolean().optional(),
});

export async function postFollowUp(req: Request, res: Response) {
  const parsed = createFollowUpSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const followUp = await createFollowUp({
    leadId: parsed.data.leadId,
    scheduledAt: new Date(parsed.data.scheduledAt),
    reason: parsed.data.reason,
    streamingEnabled: parsed.data.streamingEnabled,
  });

  callEventBus.publishGlobal("followup.created", { followUp });
  res.status(201).json({ followUp });
}

export async function getFollowUps(req: Request, res: Response) {
  const status = req.query.status as FollowUpStatus | undefined;
  const followUps = await listFollowUps(status);
  res.json({ followUps });
}

export async function postCancelFollowUp(req: Request, res: Response) {
  const result = await cancelFollowUp(req.params.followUpId);
  if (result.outcome === "not_found") return res.status(404).json({ error: "Follow-up not found" });
  if (result.outcome === "not_cancelable") {
    return res.status(409).json({ error: "Follow-up can no longer be canceled", followUp: result.followUp });
  }
  callEventBus.publishGlobal("followup.canceled", { followUp: result.followUp });
  res.json({ followUp: result.followUp });
}
