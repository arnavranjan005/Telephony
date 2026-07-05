const createCampaign = jest.fn();
const listCampaigns = jest.fn();
const getCampaign = jest.fn();
const startCampaign = jest.fn();
const pauseCampaign = jest.fn();

jest.mock("@telephony/domain", () => ({
  createCampaign: (...args: unknown[]) => createCampaign(...args),
  listCampaigns: (...args: unknown[]) => listCampaigns(...args),
  getCampaign: (...args: unknown[]) => getCampaign(...args),
  startCampaign: (...args: unknown[]) => startCampaign(...args),
  pauseCampaign: (...args: unknown[]) => pauseCampaign(...args),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Campaign routes", () => {
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

  it("POST /api/campaigns passes streamingEnabled through when the caller opts in", async () => {
    createCampaign.mockResolvedValue({ id: "camp_1", name: "Spring outreach" });

    await request(app)
      .post("/api/campaigns")
      .send({ name: "Spring outreach", streamingEnabled: true, contacts: [] });

    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Spring outreach", streamingEnabled: true })
    );
  });

  it("POST /api/campaigns rejects a request missing name", async () => {
    const res = await request(app).post("/api/campaigns").send({ contacts: [] });
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
});
