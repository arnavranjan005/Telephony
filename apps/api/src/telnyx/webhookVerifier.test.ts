import nacl from "tweetnacl";

describe("verifyTelnyxSignature", () => {
  const keyPair = nacl.sign.keyPair();
  const publicKeyBase64 = Buffer.from(keyPair.publicKey).toString("base64");

  function sign(rawBody: string, timestamp: string): string {
    const signedPayload = `${timestamp}|${rawBody}`;
    const signature = nacl.sign.detached(Buffer.from(signedPayload, "utf-8"), keyPair.secretKey);
    return Buffer.from(signature).toString("base64");
  }

  async function loadVerifier(publicKey?: string) {
    jest.resetModules();
    if (publicKey === undefined) {
      delete process.env.TELNYX_PUBLIC_KEY;
    } else {
      process.env.TELNYX_PUBLIC_KEY = publicKey;
    }
    const mod = await import("./webhookVerifier");
    return mod.verifyTelnyxSignature;
  }

  afterEach(() => {
    delete process.env.TELNYX_PUBLIC_KEY;
  });

  it("accepts a validly signed payload", async () => {
    const verify = await loadVerifier(publicKeyBase64);
    const rawBody = JSON.stringify({ data: { event_type: "call.answered" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBody, timestamp);

    expect(verify(rawBody, signature, timestamp)).toBe(true);
  });

  it("rejects a payload that was tampered with after signing", async () => {
    const verify = await loadVerifier(publicKeyBase64);
    const rawBody = JSON.stringify({ data: { event_type: "call.answered" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(rawBody, timestamp);
    const tamperedBody = JSON.stringify({ data: { event_type: "call.hangup" } });

    expect(verify(tamperedBody, signature, timestamp)).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const verify = await loadVerifier(publicKeyBase64);
    const rawBody = JSON.stringify({ data: { event_type: "call.answered" } });
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const signature = sign(rawBody, staleTimestamp);

    expect(verify(rawBody, signature, staleTimestamp)).toBe(false);
  });

  it("rejects when the signature or timestamp header is missing", async () => {
    const verify = await loadVerifier(publicKeyBase64);
    const rawBody = "{}";

    expect(verify(rawBody, undefined, "123")).toBe(false);
    expect(verify(rawBody, "sig", undefined)).toBe(false);
  });

  it("skips verification when no public key is configured (local dev)", async () => {
    const verify = await loadVerifier(undefined);
    expect(verify("anything", undefined, undefined)).toBe(true);
  });
});
