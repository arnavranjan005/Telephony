import crypto from "crypto";
import { env } from "@telephony/config";

const TOKEN_TTL_MS = 5 * 60 * 1000; // covers the delay between issuing and Telnyx's WS connect attempt

interface PendingToken {
  token: string;
  expiresAt: number;
}

const pendingTokens = new Map<string, PendingToken>();

/**
 * Issues a short-lived, single-use token for one call's media-stream
 * connection - embedded in the `stream_url` query string passed to Telnyx at
 * dial/answer time. This is the first genuinely public, unauthenticated-by-
 * default inbound endpoint in the app (unlike the Telnyx webhook, which has
 * its own signature verification), so it needs its own gate. Lives in
 * packages/domain (not apps/api) because it must be issued from
 * outboundDialService.ts, right where a newly-created Call's id becomes
 * available, before the Telnyx dial request that needs the finished
 * stream_url is ever sent.
 */
export function issueStreamToken(callId: string): string {
  // Entries are normally consumed by verifyStreamToken, but a call whose
  // stream never connects (failed dial, Telnyx never opens the WS) would
  // leave its entry behind forever - swept here so the map can't grow
  // unboundedly in a long-lived process.
  const now = Date.now();
  for (const [id, entry] of pendingTokens) {
    if (now > entry.expiresAt) pendingTokens.delete(id);
  }

  const token = crypto.randomBytes(24).toString("hex");
  pendingTokens.set(callId, { token, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/** Verifies and consumes (single-use) a token issued by issueStreamToken. */
export function verifyStreamToken(callId: string, token: string): boolean {
  const entry = pendingTokens.get(callId);
  pendingTokens.delete(callId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;

  const expected = Buffer.from(entry.token);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** Builds the wss:// media-stream URL (with an embedded single-use token) for
 * a call, to pass as `stream_url` on the Telnyx dial/answer command. */
export function buildStreamUrl(callId: string): string {
  const token = issueStreamToken(callId);
  const wsBase = env.BASE_URL.replace(/^http/, "ws");
  const url = new URL(env.MEDIA_STREAM_WS_PATH, wsBase);
  url.searchParams.set("callId", callId);
  url.searchParams.set("token", token);
  return url.toString();
}
