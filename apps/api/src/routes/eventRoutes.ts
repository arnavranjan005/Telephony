import { Router } from "express";
import { streamAllEvents } from "../sse/sseHandler";

const router = Router();

router.get("/stream", streamAllEvents);

export default router;
