import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  BASE_URL: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required (e.g. an Aiven Redis rediss:// connection string)"),
  REDIS_TLS_REJECT_UNAUTHORIZED: z.coerce.boolean().default(true),
  DIAL_RATE_LIMIT_MAX: z.coerce.number().default(5),
  DIAL_RATE_LIMIT_DURATION_MS: z.coerce.number().default(1000),

  TELNYX_API_KEY: z.string().min(1, "TELNYX_API_KEY is required"),
  TELNYX_PUBLIC_KEY: z.string().optional(),
  TELNYX_CONNECTION_ID: z.string().min(1, "TELNYX_CONNECTION_ID is required"),
  TELNYX_FROM_NUMBER: z.string().min(1, "TELNYX_FROM_NUMBER is required"),
  TELNYX_WEBHOOK_SIGNING_SECRET: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),

  AI_PROVIDER: z.enum(["google"]).default("google"),
  GOOGLE_AI_API_KEY: z.string().optional(),
  GOOGLE_AI_MODEL: z.string().default("gemini-2.0-flash"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

export const env = loadEnv();
