import { Router } from "express";
import {
  getCampaignById,
  getCampaigns,
  postCampaign,
  postPauseCampaign,
  postStartCampaign,
} from "../controllers/campaignController";

const router = Router();

router.post("/", postCampaign);
router.get("/", getCampaigns);
router.get("/:campaignId", getCampaignById);
router.post("/:campaignId/start", postStartCampaign);
router.post("/:campaignId/pause", postPauseCampaign);

export default router;
