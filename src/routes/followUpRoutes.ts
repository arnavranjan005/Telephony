import { Router } from "express";
import { getFollowUps, postCancelFollowUp, postFollowUp } from "../controllers/followUpController";

const router = Router();

router.post("/", postFollowUp);
router.get("/", getFollowUps);
router.post("/:followUpId/cancel", postCancelFollowUp);

export default router;
