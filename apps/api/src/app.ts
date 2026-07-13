// Must be imported before any routes are registered: patches Express so a
// rejected promise/thrown error in an async route handler is forwarded to
// the error middleware instead of silently hanging the request forever.
import "express-async-errors";
import express, { Request } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import callRoutes from "./routes/callRoutes";
import leadRoutes from "./routes/leadRoutes";
import appointmentRoutes from "./routes/appointmentRoutes";
import calendarRoutes from "./routes/calendarRoutes";
import campaignRoutes from "./routes/campaignRoutes";
import followUpRoutes from "./routes/followUpRoutes";
import dncRoutes from "./routes/dncRoutes";
import analyticsRoutes from "./routes/analyticsRoutes";
import eventRoutes from "./routes/eventRoutes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Capture the raw body so Telnyx webhook signatures can be verified exactly
  // as received, before JSON parsing normalizes it.
  //
  // The default body limit is 100 KB; raised to 2 MB so a full bulk lead
  // import (POST /api/leads/bulk, capped at BULK_IMPORT_MAX_ROWS) isn't
  // rejected as a payload-too-large before it reaches the handler.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req: Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf-8");
      },
    })
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api/calls", callRoutes);
  app.use("/api/leads", leadRoutes);
  app.use("/api/appointments", appointmentRoutes);
  app.use("/api/calendar", calendarRoutes);
  app.use("/api/campaigns", campaignRoutes);
  app.use("/api/followups", followUpRoutes);
  app.use("/api/dnc", dncRoutes);
  app.use("/api/analytics", analyticsRoutes);
  app.use("/api/events", eventRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
