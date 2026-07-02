import nacl from "tweetnacl";
import { env } from "../../config/env";

const TOLERANCE_SECONDS = 300;

/**
 * Verifies a Telnyx webhook's Ed25519 signature per
 * https://developers.telnyx.com/docs/api/v2/webhooks/verify-signature
 */
export function verifyTelnyxSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined
): boolean {
  if (!env.TELNYX_PUBLIC_KEY) {
    // No public key configured (e.g. local dev) - skip verification.
    return true;
  }

  if (!signatureHeader || !timestampHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }

  const signedPayload = `${timestampHeader}|${rawBody}`;
  const signature = Buffer.from(signatureHeader, "base64");
  const publicKey = Buffer.from(env.TELNYX_PUBLIC_KEY, "base64");
  const message = Buffer.from(signedPayload, "utf-8");

  return nacl.sign.detached.verify(message, signature, publicKey);
}
