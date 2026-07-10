const leadUpdate = jest.fn();
const leadFindUnique = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: {
    lead: {
      update: (...args: unknown[]) => leadUpdate(...args),
      findUnique: (...args: unknown[]) => leadFindUnique(...args),
    },
  },
}));

import { buildLeadTools } from "./leadTools";

describe("leadTools", () => {
  it("update_lead_status updates the lead when a leadId is present in context", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", status: "HOT" });

    const [updateLead] = buildLeadTools({ leadId: "lead_1" });
    const result = await updateLead.handler({ status: "HOT", notes: "Ready to buy" });

    expect(result).toEqual({ updated: true, leadId: "lead_1", status: "HOT" });
    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { status: "HOT", notes: "Ready to buy" },
    });
  });

  it("update_lead_status is a no-op when there is no lead associated with the call", async () => {
    const [updateLead] = buildLeadTools({});
    const result = await updateLead.handler({ status: "WARM" });

    expect(result).toEqual({ updated: false, reason: "No lead associated with this call" });
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  describe("get_lead_email", () => {
    it("reports the email on file for the lead", async () => {
      leadFindUnique.mockResolvedValue({ email: "jane@example.com" });

      const [, getLeadEmail] = buildLeadTools({ leadId: "lead_1" });
      const result = await getLeadEmail.handler({});

      expect(result).toEqual({ hasEmail: true, email: "jane@example.com" });
      expect(leadFindUnique).toHaveBeenCalledWith({ where: { id: "lead_1" }, select: { email: true } });
    });

    it("reports hasEmail: false when the lead has no email on file", async () => {
      leadFindUnique.mockResolvedValue({ email: null });

      const [, getLeadEmail] = buildLeadTools({ leadId: "lead_1" });
      const result = await getLeadEmail.handler({});

      expect(result).toEqual({ hasEmail: false });
    });

    it("reports hasEmail: false when the lead record itself isn't found", async () => {
      leadFindUnique.mockResolvedValue(null);

      const [, getLeadEmail] = buildLeadTools({ leadId: "lead_1" });
      const result = await getLeadEmail.handler({});

      expect(result).toEqual({ hasEmail: false });
    });

    it("is a no-op when there is no lead associated with the call", async () => {
      const [, getLeadEmail] = buildLeadTools({});
      const result = await getLeadEmail.handler({});

      expect(result).toEqual({ hasEmail: false, reason: "No lead associated with this call" });
      expect(leadFindUnique).not.toHaveBeenCalled();
    });
  });
});
