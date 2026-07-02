import { Router } from "express";
import {
  bookAppointment,
  getGoogleAuthUrl,
  handleOAuthCallback,
  listBusySlots,
} from "../controllers/calendarController";

const router = Router();

router.get("/oauth/url", getGoogleAuthUrl);
router.get("/oauth/callback", handleOAuthCallback);
router.get("/busy", listBusySlots);
router.post("/appointments", bookAppointment);

export default router;
