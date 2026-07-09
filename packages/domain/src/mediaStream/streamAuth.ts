import crypto from "crypto";
import { env } from "@telephony/config";
import { getRedisClient } from "@telephony/queue";

const TOKEN_TTL_SECONDS = 5 * 60; // covers the delay between issuing and Telnyx's WS connect attempt

const tokenKey = (callId: string) => `stream-token:${callId}`;

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
 *
 * Backed by Redis rather than an in-memory Map: the process that dials a
 * call (apps/api for manual/inbound calls, apps/worker for campaign/
 * follow-up calls) is not always the same process that later serves the
 * WebSocket upgrade and needs to verify the token - an in-memory store is
 * invisible across that process boundary, which silently broke streaming
 * for every worker-dialed call (verification always "failed" against an
 * empty map it could never have seen the token in).
 */
export async function issueStreamToken(callId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await getRedisClient().set(tokenKey(callId), token, "EX", TOKEN_TTL_SECONDS);
  return token;
}

/**
 * Verifies and consumes (single-use) a token issued by issueStreamToken.
 * GETDEL reads and deletes the key in one atomic round-trip, so two
 * concurrent verification attempts for the same callId can never both
 * succeed - whichever request Redis serializes first gets the real value,
 * the other gets null - the same single-use guarantee the old in-memory Map
 * gave for free within one process, now enforced across processes too.
 */
export async function verifyStreamToken(callId: string, token: string): Promise<boolean> {
  const expected = await getRedisClient().getdel(tokenKey(callId));
  if (!expected) return false;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(token);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/** Builds the wss:// media-stream URL (with an embedded single-use token) for
 * a call, to pass as `stream_url` on the Telnyx dial/answer command. */
export async function buildStreamUrl(callId: string): Promise<string> {
  const token = await issueStreamToken(callId);
  const wsBase = env.BASE_URL.replace(/^http/, "ws");
  const url = new URL(env.MEDIA_STREAM_WS_PATH, wsBase);
  url.searchParams.set("callId", callId);
  url.searchParams.set("token", token);
  return url.toString();
}
