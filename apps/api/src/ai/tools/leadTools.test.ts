const leadUpdate = jest.fn();

jest.mock("@telephony/database", () => ({
  prisma: { lead: { update: (...args: unknown[]) => leadUpdate(...args) } },
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
});
