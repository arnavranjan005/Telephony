import { buildSentimentTools } from "./sentimentTools";

describe("sentimentTools", () => {
  it("record_sentiment returns recorded + guidance for a known sentiment", async () => {
    const [recordSentiment] = buildSentimentTools();
    const result = await recordSentiment.handler({ sentiment: "negative", reason: "caller raised their voice" });

    expect(result).toEqual({
      recorded: true,
      sentiment: "negative",
      guidance: expect.stringContaining("frustrated"),
    });
  });

  it("record_sentiment falls back to neutral guidance for an unrecognized value", async () => {
    const [recordSentiment] = buildSentimentTools();
    const result = await recordSentiment.handler({ sentiment: "confused" });

    expect(result).toEqual({
      recorded: true,
      sentiment: "confused",
      guidance: expect.stringContaining("No notable shift"),
    });
  });
});
