const campaignCreate = jest.fn();
const campaignFindMany = jest.fn();
const campaignFindUnique = jest.fn();
const campaignUpdate = jest.fn();
const campaignContactCreate = jest.fn();
const campaignContactFindMany = jest.fn();
const campaignContactUpdate = jest.fn();
const leadUpsert = jest.fn();

jest.mock("../config/prisma", () => ({
  prisma: {
    campaign: {
      create: (...args: unknown[]) => campaignCreate(...args),
      findMany: (...args: unknown[]) => campaignFindMany(...args),
      findUnique: (...args: unknown[]) => campaignFindUnique(...args),
      update: (...args: unknown[]) => campaignUpdate(...args),
    },
    campaignContact: {
      create: (...args: unknown[]) => campaignContactCreate(...args),
      findMany: (...args: unknown[]) => campaignContactFindMany(...args),
      update: (...args: unknown[]) => campaignContactUpdate(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
    },
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

import { createCampaign, dispatchNextCampaignContacts } from "./campaignService";

describe("campaignService", () => {
  describe("createCampaign", () => {
    it("upserts a lead by phone number for contacts without a leadId", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      leadUpsert.mockResolvedValue({ id: "lead_new" });
      campaignContactCreate.mockResolvedValue({});
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        contacts: [{ phoneNumber: "+15551234567", firstName: "Jane" }],
      });

      expect(leadUpsert).toHaveBeenCalledWith({
        where: { phoneNumber: "+15551234567" },
        update: {},
        create: { phoneNumber: "+15551234567", firstName: "Jane", lastName: undefined },
      });
      expect(campaignContactCreate).toHaveBeenCalledWith({
        data: { campaignId: "camp_1", leadId: "lead_new" },
      });
    });

    it("uses the given leadId directly without upserting a lead", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignContactCreate.mockResolvedValue({});
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({ name: "Spring outreach", contacts: [{ leadId: "lead_existing" }] });

      expect(leadUpsert).not.toHaveBeenCalled();
      expect(campaignContactCreate).toHaveBeenCalledWith({
        data: { campaignId: "camp_1", leadId: "lead_existing" },
      });
    });
  });

  describe("dispatchNextCampaignContacts", () => {
    it("dials PENDING contacts of RUNNING campaigns and marks them CALLING", async () => {
      campaignFindMany.mockResolvedValue([{ id: "camp_1", status: "RUNNING" }]);
      campaignContactFindMany.mockResolvedValue([
        { id: "cc_1", leadId: "lead_1", lead: { phoneNumber: "+15551234567" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });

      const dispatched = await dispatchNextCampaignContacts(5);

      expect(dispatched).toBe(1);
      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1");
      expect(campaignContactUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cc_1" },
          data: expect.objectContaining({ status: "CALLING", callId: "call_1" }),
        })
      );
    });

    it("marks a DNC-listed contact SKIPPED_DNC without counting it as dispatched", async () => {
      campaignFindMany.mockResolvedValue([{ id: "camp_1", status: "RUNNING" }]);
      campaignContactFindMany.mockResolvedValue([
        { id: "cc_1", leadId: "lead_1", lead: { phoneNumber: "+15551234567" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });

      const dispatched = await dispatchNextCampaignContacts(5);

      expect(dispatched).toBe(0);
      expect(campaignContactUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "cc_1" }, data: expect.objectContaining({ status: "SKIPPED_DNC" }) })
      );
    });

    it("marks the campaign COMPLETED once there are no PENDING contacts left", async () => {
      campaignFindMany.mockResolvedValue([{ id: "camp_1", status: "RUNNING" }]);
      campaignContactFindMany.mockResolvedValue([]);

      await dispatchNextCampaignContacts(5);

      expect(campaignUpdate).toHaveBeenCalledWith({ where: { id: "camp_1" }, data: { status: "COMPLETED" } });
      expect(placeOutboundCall).not.toHaveBeenCalled();
    });

    it("respects the per-tick dial cap across campaigns", async () => {
      campaignFindMany.mockResolvedValue([{ id: "camp_1", status: "RUNNING" }]);
      campaignContactFindMany.mockResolvedValue([
        { id: "cc_1", leadId: "lead_1", lead: { phoneNumber: "+15551111111" } },
        { id: "cc_2", leadId: "lead_2", lead: { phoneNumber: "+15552222222" } },
      ]);
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_x" });

      const dispatched = await dispatchNextCampaignContacts(2);

      expect(dispatched).toBe(2);
      expect(campaignContactFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 })
      );
    });
  });
});
