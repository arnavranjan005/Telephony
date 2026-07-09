import { ConnectionOptions } from "bullmq";
import Redis from "ioredis";
import { env } from "@telephony/config";

/**
 * Shared parsing for both `redisConnection` (handed to BullMQ, which builds
 * its own client) and `getRedisClient()` (a real client callers can issue
 * commands on directly) below, so the two never drift out of sync with each
 * other on host/port/TLS. ioredis enables TLS automatically once `tls` is
 * set, which is what Aiven's `rediss://` managed Redis requires.
 */
function parseRedisUrl() {
  const url = new URL(env.REDIS_URL);

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? { rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED } : undefined,
  };
}

/**
 * Plain connection options (not a live ioredis instance) for BullMQ. BullMQ
 * bundles its own internal ioredis version, which is not type-compatible
 * with a client built from a separately-installed `ioredis` package - so we
 * hand it connection details and let it build clients itself.
 */
export const redisConnection: ConnectionOptions = { ...parseRedisUrl(), maxRetriesPerRequest: null };

/**
 * A real, directly-usable ioredis client for callers that need to run plain
 * Redis commands themselves (e.g. streamAuth.ts's cross-process single-use
 * token store, which needs a store every process can see - unlike an
 * in-memory Map, which only the one process holding it can read) rather than
 * handing connection details to BullMQ. Separate from `redisConnection`
 * above for the type-compatibility reason noted there. Lazily connected so
 * importing this module never opens a socket nothing ends up using, and
 * memoized so every caller shares one connection instead of opening a new
 * one per call.
 */
let client: Redis | undefined;
export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis({ ...parseRedisUrl(), lazyConnect: true, maxRetriesPerRequest: 3 });
  }
  return client;
}
