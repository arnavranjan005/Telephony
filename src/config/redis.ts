import { ConnectionOptions } from "bullmq";
import { env } from "./env";

/**
 * Plain connection options (not a live ioredis instance) for BullMQ. BullMQ
 * bundles its own internal ioredis version, which is not type-compatible
 * with a client built from a separately-installed `ioredis` package - so we
 * hand it connection details and let it build clients itself. ioredis (and
 * BullMQ's bundled copy) enables TLS automatically once `tls` is set, which
 * is what Aiven's `rediss://` managed Redis requires.
 */
function buildConnectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);

  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? { rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED } : undefined,
    maxRetriesPerRequest: null,
  };
}

export const redisConnection: ConnectionOptions = buildConnectionOptions();
