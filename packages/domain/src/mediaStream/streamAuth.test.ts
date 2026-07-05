jest.mock("@telephony/config", () => ({
  env: { BASE_URL: "http://localhost:3000", MEDIA_STREAM_WS_PATH: "/media-stream" },
}));

import { buildStreamUrl, issueStreamToken, verifyStreamToken } from "./streamAuth";

describe("streamAuth", () => {
  it("issues a token that verifies successfully for the same call", () => {
    const token = issueStreamToken("call_1");
    expect(verifyStreamToken("call_1", token)).toBe(true);
  });

  it("is single-use - a second verification attempt fails", () => {
    const token = issueStreamToken("call_1");
    expect(verifyStreamToken("call_1", token)).toBe(true);
    expect(verifyStreamToken("call_1", token)).toBe(false);
  });

  it("rejects a token for the wrong call", () => {
    const token = issueStreamToken("call_1");
    expect(verifyStreamToken("call_2", token)).toBe(false);
  });

  it("rejects a wrong token for the right call", () => {
    issueStreamToken("call_1");
    expect(verifyStreamToken("call_1", "wrong-token")).toBe(false);
  });

  it("rejects verification when no token was ever issued", () => {
    expect(verifyStreamToken("never_issued", "anything")).toBe(false);
  });

  it("rejects an expired token", () => {
    jest.useFakeTimers().setSystemTime(0);
    const token = issueStreamToken("call_1");

    jest.setSystemTime(6 * 60 * 1000); // past the 5-minute TTL
    expect(verifyStreamToken("call_1", token)).toBe(false);

    jest.useRealTimers();
  });

  describe("buildStreamUrl", () => {
    it("builds a wss:// URL with the callId and an issued token embedded", () => {
      const url = buildStreamUrl("call_1");
      const parsed = new URL(url);

      expect(parsed.protocol).toBe("ws:");
      expect(parsed.pathname).toBe("/media-stream");
      expect(parsed.searchParams.get("callId")).toBe("call_1");

      const token = parsed.searchParams.get("token");
      expect(token).toBeTruthy();
      expect(verifyStreamToken("call_1", token!)).toBe(true);
    });
  });
});
