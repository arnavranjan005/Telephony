import { Router } from "express";
import {
  bookAppointment,
  getGoogleAuthUrl,
  handleOAuthCallback,
  listBusySlots,
} from "../controllers/calendarController";
import { idempotency } from "../middleware/idempotency";

const router = Router();

router.get("/oauth/url", getGoogleAuthUrl);
router.get("/oauth/callback", handleOAuthCallback);
router.get("/busy", listBusySlots);
router.post("/appointments", idempotency, bookAppointment);

export default router;
