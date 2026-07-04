const leadUpdate = jest.fn();
const leadFindUnique = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    lead: {
      update: (...args: unknown[]) => leadUpdate(...args),
      findUnique: (...args: unknown[]) => leadFindUnique(...args),
    },
  },
  ConsentStatus: { UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", REVOKED: "REVOKED" },
}));

import { hasConsent, recordConsent, revokeConsent } from "./consentService";

describe("consentService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("recordConsent marks the lead GRANTED with a source and timestamp", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", consentStatus: "GRANTED" });

    await recordConsent("lead_1", "web-form");

    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { consentStatus: "GRANTED", consentSource: "web-form", consentedAt: expect.any(Date) },
    });
  });

  it("revokeConsent marks the lead REVOKED", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", consentStatus: "REVOKED" });

    await revokeConsent("lead_1");

    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { consentStatus: "REVOKED", consentedAt: expect.any(Date) },
    });
  });

  it("hasConsent is true only when consentStatus is GRANTED", async () => {
    leadFindUnique.mockResolvedValue({ consentStatus: "GRANTED" });
    expect(await hasConsent("lead_1")).toBe(true);

    leadFindUnique.mockResolvedValue({ consentStatus: "REVOKED" });
    expect(await hasConsent("lead_1")).toBe(false);

    leadFindUnique.mockResolvedValue({ consentStatus: "UNKNOWN" });
    expect(await hasConsent("lead_1")).toBe(false);
  });

  it("hasConsent is false when the lead doesn't exist", async () => {
    leadFindUnique.mockResolvedValue(null);
    expect(await hasConsent("missing")).toBe(false);
  });
});
