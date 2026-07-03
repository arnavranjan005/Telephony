import { Router } from "express";
import { getFollowUps, postCancelFollowUp, postFollowUp } from "../controllers/followUpController";
import { idempotency } from "../middleware/idempotency";

const router = Router();

router.post("/", idempotency, postFollowUp);
router.get("/", getFollowUps);
router.post("/:followUpId/cancel", postCancelFollowUp);

export default router;
