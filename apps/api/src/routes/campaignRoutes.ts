import { Router } from "express";
import {
  getCampaignById,
  getCampaigns,
  getObjectionBaseline,
  postCampaign,
  postPauseCampaign,
  postStartCampaign,
} from "../controllers/campaignController";
import { idempotency } from "../middleware/idempotency";

const router = Router();

router.post("/", idempotency, postCampaign);
router.get("/", getCampaigns);
// Must come before "/:campaignId" - otherwise Express would match this
// literal path as a campaignId param instead.
router.get("/objection-baseline", getObjectionBaseline);
router.get("/:campaignId", getCampaignById);
router.post("/:campaignId/start", postStartCampaign);
router.post("/:campaignId/pause", postPauseCampaign);

export default router;
