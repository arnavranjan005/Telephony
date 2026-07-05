import { Request, Response } from "express";
import { getCallTimeseries, getCampaignPerformance, getOverviewStats } from "@telephony/domain";

export async function getOverview(_req: Request, res: Response) {
  const stats = await getOverviewStats();
  res.json(stats);
}

export async function getCampaignsPerformance(_req: Request, res: Response) {
  const campaigns = await getCampaignPerformance();
  res.json({ campaigns });
}

export async function getTimeseries(req: Request, res: Response) {
  const days = Number(req.query.days ?? 14);
  const safeDays = Number.isFinite(days) && days > 0 && days <= 90 ? days : 14;
  const points = await getCallTimeseries(safeDays);
  res.json({ points });
}
