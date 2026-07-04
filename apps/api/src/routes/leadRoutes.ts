import { Router } from "express";
import { createLead, deleteLead, getLead, listLeads, setLeadConsent, updateLead } from "../controllers/leadController";
import { idempotency } from "../middleware/idempotency";

const router = Router();

router.post("/", idempotency, createLead);
router.get("/", listLeads);
router.get("/:leadId", getLead);
router.patch("/:leadId", updateLead);
router.post("/:leadId/consent", setLeadConsent);
router.delete("/:leadId", deleteLead);

export default router;
