import express, { Request } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import callRoutes from "./routes/callRoutes";
import leadRoutes from "./routes/leadRoutes";
import appointmentRoutes from "./routes/appointmentRoutes";
import calendarRoutes from "./routes/calendarRoutes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Capture the raw body so Telnyx webhook signatures can be verified exactly
  // as received, before JSON parsing normalizes it.
  app.use(
    express.json({
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
