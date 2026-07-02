import { Router } from "express";
import { cancelAppointment, getAppointment, listAppointments } from "../controllers/appointmentController";

const router = Router();

router.get("/", listAppointments);
router.get("/:appointmentId", getAppointment);
router.post("/:appointmentId/cancel", cancelAppointment);

export default router;
