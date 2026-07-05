import { Router } from "express";
import { getCampaignsPerformance, getOverview, getTimeseries } from "../controllers/analyticsController";

const router = Router();

router.get("/overview", getOverview);
router.get("/campaigns", getCampaignsPerformance);
router.get("/timeseries", getTimeseries);

export default router;
