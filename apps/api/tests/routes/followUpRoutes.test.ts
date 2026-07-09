const createFollowUp = jest.fn();
const listFollowUps = jest.fn();
const cancelFollowUp = jest.fn();

jest.mock("@telephony/domain", () => ({
  createFollowUp: (...args: unknown[]) => createFollowUp(...args),
  listFollowUps: (...args: unknown[]) => listFollowUps(...args),
  cancelFollowUp: (...args: unknown[]) => cancelFollowUp(...args),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Follow-up routes", () => {
  it("POST /api/followups creates a follow-up", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1" });

    const res = await request(app)
      .post("/api/followups")
      .send({ leadId: "lead_1", scheduledAt: "2025-01-16T18:00:00Z", reason: "callback" });

    expect(res.status).toBe(201);
    expect(createFollowUp).toHaveBeenCalledWith({
      leadId: "lead_1",
      scheduledAt: new Date("2025-01-16T18:00:00Z"),
      reason: "callback",
    });
  });

  it("POST /api/followups passes streamingEnabled through when the caller opts in", async () => {
    createFollowUp.mockResolvedValue({ id: "fu_1" });

    await request(app)
      .post("/api/followups")
      .send({ leadId: "lead_1", scheduledAt: "2025-01-16T18:00:00Z", streamingEnabled: true });

    expect(createFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "lead_1", streamingEnabled: true })
    );
  });

  it("POST /api/followups rejects a request missing leadId", async () => {
    const res = await request(app).post("/api/followups").send({ scheduledAt: "2025-01-16T18:00:00Z" });
    expect(res.status).toBe(400);
    expect(createFollowUp).not.toHaveBeenCalled();
  });

  it("POST /api/followups rejects an unparseable scheduledAt with 400 instead of passing Invalid Date through", async () => {
    const res = await request(app).post("/api/followups").send({ leadId: "lead_1", scheduledAt: "not-a-date" });
    expect(res.status).toBe(400);
    expect(createFollowUp).not.toHaveBeenCalled();
  });

  it("GET /api/followups lists follow-ups", async () => {
    listFollowUps.mockResolvedValue([{ id: "fu_1" }]);
    const res = await request(app).get("/api/followups");
    expect(res.status).toBe(200);
    expect(res.body.followUps).toHaveLength(1);
  });

  it("POST /api/followups/:id/cancel cancels the follow-up", async () => {
    cancelFollowUp.mockResolvedValue({ outcome: "canceled", followUp: { id: "fu_1", status: "CANCELED" } });
    const res = await request(app).post("/api/followups/fu_1/cancel");
    expect(res.status).toBe(200);
    expect(res.body.followUp.status).toBe("CANCELED");
    expect(cancelFollowUp).toHaveBeenCalledWith("fu_1");
  });

  it("POST /api/followups/:id/cancel returns 404 for an unknown follow-up", async () => {
    cancelFollowUp.mockResolvedValue({ outcome: "not_found" });
    const res = await request(app).post("/api/followups/missing/cancel");
    expect(res.status).toBe(404);
  });

  it("POST /api/followups/:id/cancel returns 409 when the follow-up is no longer cancelable (e.g. already CALLING)", async () => {
    cancelFollowUp.mockResolvedValue({ outcome: "not_cancelable", followUp: { id: "fu_1", status: "CALLING" } });
    const res = await request(app).post("/api/followups/fu_1/cancel");
    expect(res.status).toBe(409);
  });
});
