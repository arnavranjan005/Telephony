import { createHash } from "crypto";
import { NextFunction, Request, Response } from "express";
import { Prisma, prisma } from "@telephony/database";

const IDEMPOTENCY_HEADER = "idempotency-key";

function hashRequest(method: string, path: string, body: unknown): string {
  const normalized = JSON.stringify(body ?? {});
  return createHash("sha256").update(`${method}:${path}:${normalized}`).digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Opt-in Idempotency-Key support (Stripe-style) for POST endpoints that
 * create resources or trigger a real-world side effect (placing a call,
 * booking a calendar event, scheduling a callback). A client that sends the
 * same `Idempotency-Key` header on a retry gets the original response
 * replayed instead of the operation running twice.
 *
 * - The key is claimed atomically via a unique-constraint INSERT, so two
 *   concurrent requests with the same key can't both proceed - the loser
 *   gets 409.
 * - A completed response is only cached for status < 500: a transient
 *   failure (e.g. Telnyx briefly down) shouldn't permanently lock a client
 *   out of ever successfully retrying that key, so the claim is released
 *   (the row deleted) on 5xx instead of cached.
 * - Reusing a key with a different request body is rejected with 422 -
 *   otherwise a client bug (reusing a key across unrelated requests) would
 *   silently return the wrong cached response.
 *
 * No-op when the header is absent, so existing callers are unaffected.
 */
export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.header(IDEMPOTENCY_HEADER);
  if (!key) {
    next();
    return;
  }

  const requestHash = hashRequest(req.method, req.originalUrl, req.body);

  try {
    await prisma.idempotencyKey.create({
      data: { key, method: req.method, path: req.originalUrl, requestHash },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (!existing) {
      // Released between our failed create and this lookup (e.g. the
      // original request just failed with a 5xx) - safe to let it proceed.
      next();
      return;
    }

    if (existing.requestHash !== requestHash) {
      res.status(422).json({ error: "Idempotency-Key was already used with a different request body" });
      return;
    }

    if (existing.status === "PENDING") {
      res.status(409).json({ error: "A request with this Idempotency-Key is already being processed" });
      return;
    }

    res.status(existing.responseStatus ?? 200).json(existing.responseBody ?? {});
    return;
  }

  let capturedBody: unknown;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body: unknown) => {
    capturedBody = body;
    return originalJson(body);
  };
  res.send = (body?: unknown) => {
    capturedBody = capturedBody ?? body;
    return originalSend(body as never);
  };

  res.on("finish", () => {
    void finalizeIdempotencyKey(key, res.statusCode, capturedBody);
  });

  next();
}

async function finalizeIdempotencyKey(key: string, statusCode: number, body: unknown): Promise<void> {
  try {
    if (statusCode >= 500) {
      // Release the claim so a genuine retry can actually re-attempt the
      // operation instead of being wedged on a transient failure forever.
      await prisma.idempotencyKey.deleteMany({ where: { key } });
      return;
    }

    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: "COMPLETED", responseStatus: statusCode, responseBody: body as never, completedAt: new Date() },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Failed to finalize idempotency key ${key}:`, error);
  }
}
