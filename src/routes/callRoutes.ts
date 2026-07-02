import { Router } from "express";
import { createOutboundCall, getCall, handleTelnyxWebhook, listCalls } from "../controllers/callController";
import { streamCallEvents } from "../sse/sseHandler";

const router = Router();

router.post("/outbound", createOutboundCall);
router.get("/", listCalls);
router.get("/:callId", getCall);
router.get("/:callId/events", streamCallEvents);
router.post("/webhook", handleTelnyxWebhook);

export default router;
