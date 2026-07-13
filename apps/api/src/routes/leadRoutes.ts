import { Router } from "express";
import {
  bulkCreateLeads,
  createLead,
  deleteLead,
  getLead,
  listLeads,
  setLeadConsent,
  updateLead,
} from "../controllers/leadController";
import { idempotency } from "../middleware/idempotency";

const router = Router();

router.post("/", idempotency, createLead);
router.post("/bulk", idempotency, bulkCreateLeads);
router.get("/", listLeads);
router.get("/:leadId", getLead);
router.patch("/:leadId", updateLead);
router.post("/:leadId/consent", setLeadConsent);
router.delete("/:leadId", deleteLead);

export default router;
