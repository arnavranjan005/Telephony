const createCampaign = jest.fn();
const listCampaigns = jest.fn();
const getCampaign = jest.fn();
const startCampaign = jest.fn();
const pauseCampaign = jest.fn();
const deleteCampaignLeads = jest.fn();

jest.mock("@telephony/domain", () => ({
  createCampaign: (...args: unknown[]) => createCampaign(...args),
  listCampaigns: (...args: unknown[]) => listCampaigns(...args),
  getCampaign: (...args: unknown[]) => getCampaign(...args),
  startCampaign: (...args: unknown[]) => startCampaign(...args),
  pauseCampaign: (...args: unknown[]) => pauseCampaign(...args),
  deleteCampaignLeads: (...args: unknown[]) => deleteCampaignLeads(...args),
  CampaignNotDraftError: class CampaignNotDraftError extends Error {},
}));

import request from "supertest";
import { createApp } from "../../src/app";
import { DEFAULT_OUTBOUND_OPENING_LINE, OBJECTION_HANDLING_BASELINE } from "../../src/callConversationService";

const app = createApp();

describe("Campaign routes", () => {
  it("GET /api/campaigns/objection-baseline returns the baseline objection-handling text", async () => {
    const res = await request(app).get("/api/campaigns/objection-baseline");
    expect(res.status).toBe(200);
    expect(res.body.text).toBe(OBJECTION_HANDLING_BASELINE);
  });
  it("GET /api/campaigns/opening-line-default returns the default outbound opening line", async () => {
    const res = await request(app).get("/api/campaigns/opening-line-default");
    expect(res.status).toBe(200);
    expect(res.body.text).toBe(DEFAULT_OUTBOUND_OPENING_LINE);
  });
  it("POST /api/campaigns creates a campaign with its contacts", async () => {
    createCampaign.mockResolvedValue({ id: "camp_1", name: "Spring outreach" });

    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "Spring outreach", script: "Ask about renewal", contacts: [{ phoneNumber: "+15551234567" }] });

    expect(res.status).toBe(201);
    expect(res.body.campaign.id).toBe("camp_1");
    expect(createCampaign).toHaveBeenCalledWith({
      name: "Spring outreach",
      script: "Ask about renewal",
      contacts: [{ phoneNumber: "+15551234567" }],
    });
  });

  it("POST /api/campaigns passes objectionPlaybook through when provided", async () => {
    createCampaign.mockResolvedValue({ id: "camp_1", name: "Spring outreach" });

    await request(app)
      .post("/api/campaigns")
      .send({
        name: "Spring outreach",
        script: "Ask about renewal",
        objectionPlaybook: "If price is the objection, mention the 3-installment plan",
        contacts: [],
      });

    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ objectionPlaybook: "If price is the objection, mention the 3-installment plan" })
    );
  });

  it("POST /api/campaigns passes streamingEnabled through when the caller opts in", async () => {
    createCampaign.mockResolvedValue({ id: "camp_1", name: "Spring outreach" });

    await request(app)
      .post("/api/campaigns")
      .send({ name: "Spring outreach", script: "Ask about renewal", streamingEnabled: true, contacts: [] });

    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Spring outreach", streamingEnabled: true })
    );
  });

  it("POST /api/campaigns sanitizes contact phone numbers to E.164 before saving", async () => {
    createCampaign.mockResolvedValue({ id: "camp_1", name: "Spring outreach" });

    await request(app)
      .post("/api/campaigns")
      .send({
        name: "Spring outreach",
        script: "Ask about renewal",
        contacts: [{ phoneNumber: "+1 337-368-6335" }],
      });

    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ contacts: [{ phoneNumber: "+13373686335" }] })
    );
  });

  it("POST /api/campaigns rejects a contact phone number that isn't valid E.164 after sanitizing", async () => {
    const res = await request(app)
      .post("/api/campaigns")
      .send({ name: "Spring outreach", script: "Ask about renewal", contacts: [{ phoneNumber: "337-368-6335" }] });

    expect(res.status).toBe(400);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it("POST /api/campaigns rejects a request missing name", async () => {
    const res = await request(app).post("/api/campaigns").send({ script: "Ask about renewal", contacts: [] });
    expect(res.status).toBe(400);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it("POST /api/campaigns rejects a request missing script", async () => {
    const res = await request(app).post("/api/campaigns").send({ name: "Spring outreach", contacts: [] });
    expect(res.status).toBe(400);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it("GET /api/campaigns lists campaigns", async () => {
    listCampaigns.mockResolvedValue([{ id: "camp_1" }]);
    const res = await request(app).get("/api/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
  });

  it("GET /api/campaigns/:id returns 404 when not found", async () => {
    getCampaign.mockResolvedValue(null);
    const res = await request(app).get("/api/campaigns/missing");
    expect(res.status).toBe(404);
  });

  it("POST /api/campaigns/:id/start starts the campaign", async () => {
    startCampaign.mockResolvedValue({ id: "camp_1", status: "RUNNING" });
    const res = await request(app).post("/api/campaigns/camp_1/start");
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe("RUNNING");
    expect(startCampaign).toHaveBeenCalledWith("camp_1");
  });

  it("POST /api/campaigns/:id/pause pauses the campaign", async () => {
    pauseCampaign.mockResolvedValue({ id: "camp_1", status: "PAUSED" });
    const res = await request(app).post("/api/campaigns/camp_1/pause");
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe("PAUSED");
  });

  it("DELETE /api/campaigns/:id/contacts deletes clean leads and reports counts with reasons", async () => {
    const skippedLeads = [{ id: "lead_1", name: "Blocked Co", phoneNumber: "+15551234567", reason: "2 calls" }];
    deleteCampaignLeads.mockResolvedValue({
      campaign: { id: "camp_1", contacts: [] },
      deleted: 3,
      skipped: 1,
      skippedLeads,
    });
    const res = await request(app).delete("/api/campaigns/camp_1/contacts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: 3, skipped: 1, skippedLeads });
    expect(deleteCampaignLeads).toHaveBeenCalledWith("camp_1");
  });

  it("DELETE /api/campaigns/:id/contacts returns 404 for a campaign that doesn't exist", async () => {
    deleteCampaignLeads.mockResolvedValue(null);
    const res = await request(app).delete("/api/campaigns/missing/contacts");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/campaigns/:id/contacts returns 409 for a campaign that already started", async () => {
    const { CampaignNotDraftError } = jest.requireMock("@telephony/domain") as { CampaignNotDraftError: new (s: string) => Error };
    deleteCampaignLeads.mockRejectedValue(new CampaignNotDraftError("RUNNING"));
    const res = await request(app).delete("/api/campaigns/camp_1/contacts");
    expect(res.status).toBe(409);
  });
});
