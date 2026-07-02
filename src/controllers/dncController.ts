import { Request, Response } from "express";
import { z } from "zod";
import { addToDnc, listDnc, removeFromDnc } from "../lib/compliance/dncService";

export async function getDncList(_req: Request, res: Response) {
  const entries = await listDnc();
  res.json({ entries });
}

const addDncSchema = z.object({
  phoneNumber: z.string().min(1),
  reason: z.string().optional(),
});

export async function addDncEntry(req: Request, res: Response) {
  const parsed = addDncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const entry = await addToDnc(parsed.data.phoneNumber, parsed.data.reason);
  res.status(201).json({ entry });
}

export async function removeDncEntry(req: Request, res: Response) {
  await removeFromDnc(req.params.phoneNumber);
  res.status(204).send();
}
