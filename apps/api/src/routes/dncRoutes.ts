import { Router } from "express";
import { addDncEntry, getDncList, removeDncEntry } from "../controllers/dncController";

const router = Router();

router.get("/", getDncList);
router.post("/", addDncEntry);
router.delete("/:phoneNumber", removeDncEntry);

export default router;
