import { Router } from "express";
import {
  deleteCampaignContacts,
  getCampaignById,
  getCampaigns,
  getObjectionBaseline,
  getOpeningLineDefault,
  postCampaign,
  postCampaignContacts,
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
router.get("/opening-line-default", getOpeningLineDefault);
router.get("/:campaignId", getCampaignById);
router.post("/:campaignId/start", postStartCampaign);
router.post("/:campaignId/pause", postPauseCampaign);
router.post("/:campaignId/contacts", idempotency, postCampaignContacts);
router.delete("/:campaignId/contacts", deleteCampaignContacts);

export default router;
