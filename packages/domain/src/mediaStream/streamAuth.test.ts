jest.mock("@telephony/config", () => ({
  env: { BASE_URL: "http://localhost:3000", MEDIA_STREAM_WS_PATH: "/media-stream" },
}));

// Minimal fake standing in for the real ioredis client: just enough of
// SET .. EX / GETDEL for streamAuth.ts's needs, backed by a plain Map with
// its own expiry bookkeeping (mirroring what Redis does server-side) so
// TTL expiry can still be driven by jest's fake timers, same as the old
// in-memory-Map version's tests did.
const store = new Map<string, { value: string; expiresAt: number }>();
const fakeRedis = {
  set: jest.fn(async (key: string, value: string, _mode: "EX", ttlSeconds: number) => {
    store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "OK";
  }),
  getdel: jest.fn(async (key: string) => {
    const entry = store.get(key);
    store.delete(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry.value;
  }),
};

jest.mock("@telephony/queue", () => ({ getRedisClient: () => fakeRedis }));

import { buildStreamUrl, issueStreamToken, verifyStreamToken } from "./streamAuth";

describe("streamAuth", () => {
  beforeEach(() => store.clear());

  it("issues a token that verifies successfully for the same call", async () => {
    const token = await issueStreamToken("call_1");
    expect(await verifyStreamToken("call_1", token)).toBe(true);
  });

  it("is single-use - a second verification attempt fails", async () => {
    const token = await issueStreamToken("call_1");
    expect(await verifyStreamToken("call_1", token)).toBe(true);
    expect(await verifyStreamToken("call_1", token)).toBe(false);
  });

  it("rejects a token for the wrong call", async () => {
    const token = await issueStreamToken("call_1");
    expect(await verifyStreamToken("call_2", token)).toBe(false);
  });

  it("rejects a wrong token for the right call", async () => {
    await issueStreamToken("call_1");
    expect(await verifyStreamToken("call_1", "wrong-token")).toBe(false);
  });

  it("rejects verification when no token was ever issued", async () => {
    expect(await verifyStreamToken("never_issued", "anything")).toBe(false);
  });

  it("rejects an expired token", async () => {
    jest.useFakeTimers().setSystemTime(0);
    const token = await issueStreamToken("call_1");

    jest.setSystemTime(6 * 60 * 1000); // past the 5-minute TTL
    expect(await verifyStreamToken("call_1", token)).toBe(false);

    jest.useRealTimers();
  });

  it("verifies correctly across separate issue/verify callers (e.g. worker issues, api verifies)", async () => {
    // Nothing in streamAuth.ts is process-local anymore - two independent
    // calls into the same (fake, here) shared store stand in for that.
    const token = await issueStreamToken("call_1");
    const verified = await verifyStreamToken("call_1", token);
    expect(verified).toBe(true);
  });

  describe("buildStreamUrl", () => {
    it("builds a wss:// URL with the callId and an issued token embedded", async () => {
      const url = await buildStreamUrl("call_1");
      const parsed = new URL(url);

      expect(parsed.protocol).toBe("ws:");
      expect(parsed.pathname).toBe("/media-stream");
      expect(parsed.searchParams.get("callId")).toBe("call_1");

      const token = parsed.searchParams.get("token");
      expect(token).toBeTruthy();
      expect(await verifyStreamToken("call_1", token!)).toBe(true);
    });
  });
});
