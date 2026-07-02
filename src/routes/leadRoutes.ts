import { Router } from "express";
import { createLead, deleteLead, getLead, listLeads, updateLead } from "../controllers/leadController";

const router = Router();

router.post("/", createLead);
router.get("/", listLeads);
router.get("/:leadId", getLead);
router.patch("/:leadId", updateLead);
router.delete("/:leadId", deleteLead);

export default router;
