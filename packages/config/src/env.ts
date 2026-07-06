import dotenv from "dotenv";
import path from "path";
import { z } from "zod";

// Every app runs with its own cwd (Nx sets `cwd: apps/api` etc.), so plain
// `dotenv/config` (which reads .env from process.cwd()) would miss the
// single .env file at the repo root. Resolve relative to this module's own
// location instead - stable regardless of how/where the caller was invoked
// from, and lands at the repo root the same way whether running compiled
// (packages/config/dist/env.js) or directly under ts-jest (packages/config/src/env.ts),
// since both are exactly two directories below the root.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// z.coerce.boolean() coerces via plain `Boolean(value)`, which is `true` for
// *any* non-empty string - including the literal string "false" - so it
// can't parse an env var's textual "true"/"false" the way anyone reading a
// .env file would expect. This parses the string form correctly while still
// accepting an already-boolean value (e.g. from a test's mocked env object).
const booleanEnv = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  BASE_URL: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required (e.g. an Aiven Redis rediss:// connection string)"),
  REDIS_TLS_REJECT_UNAUTHORIZED: booleanEnv.default(true),
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
  GOOGLE_AI_MODEL: z.string().default("gemini-2.5-flash"),

  // Bidirectional media streaming (real-time barge-in) - the default calling
  // path. Provider keys below are required unless this is explicitly turned
  // off (MEDIA_STREAM_ENABLED=false) to fall back to the legacy
  // transcribe-then-speak webhook flow.
  MEDIA_STREAM_ENABLED: booleanEnv.default(true),
  MEDIA_STREAM_WS_PATH: z.string().default("/media-stream"),
  MEDIA_STREAM_SAMPLE_RATE: z.coerce.number().default(8000),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-2-phonecall"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  // Voice tuning, passed through as ElevenLabs' `voice_settings` on every TTS
  // request - defaults favor a warmer, more natural-sounding phone voice over
  // ElevenLabs' own flatter/more consistent defaults (stability 0.5,
  // similarity_boost 0.75, style 0, speaker_boost off). Lower stability and a
  // touch of style trade some consistency for expressiveness; still bounded
  // well short of the erratic end of ElevenLabs' own range.
  ELEVENLABS_STABILITY: z.coerce.number().min(0).max(1).default(0.45),
  ELEVENLABS_SIMILARITY_BOOST: z.coerce.number().min(0).max(1).default(0.8),
  ELEVENLABS_STYLE: z.coerce.number().min(0).max(1).default(0.3),
  ELEVENLABS_SPEAKER_BOOST: booleanEnv.default(true),
  ELEVENLABS_SPEED: z.coerce.number().min(0.7).max(1.2).default(1.0),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  if (parsed.data.MEDIA_STREAM_ENABLED) {
    const missing = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"].filter(
      (key) => !parsed.data[key as keyof typeof parsed.data]
    );
    if (missing.length > 0) {
      console.error(
        `MEDIA_STREAM_ENABLED is on (the default) but missing: ${missing.join(", ")}. ` +
          "Set them, or set MEDIA_STREAM_ENABLED=false to use the legacy webhook-based calling flow instead."
      );
      throw new Error("Invalid environment configuration");
    }
  }

  return parsed.data;
}

export const env = loadEnv();
