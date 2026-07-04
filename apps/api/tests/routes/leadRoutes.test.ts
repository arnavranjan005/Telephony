const leadCreate = jest.fn();
const leadFindMany = jest.fn();
const leadFindUnique = jest.fn();
const leadUpdate = jest.fn();
const leadDeleteMany = jest.fn();

jest.mock("@telephony/database", () => ({
  // Spread the real Prisma enums (LeadStatus, MessageRole, etc.) so any
  // module transitively loaded via app.ts - not just this test's target
  // controller - gets real enum values instead of undefined.
  ...jest.requireActual("@prisma/client"),
  prisma: {
    lead: {
      create: (...args: unknown[]) => leadCreate(...args),
      findMany: (...args: unknown[]) => leadFindMany(...args),
      findUnique: (...args: unknown[]) => leadFindUnique(...args),
      update: (...args: unknown[]) => leadUpdate(...args),
      deleteMany: (...args: unknown[]) => leadDeleteMany(...args),
    },
  },
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("Lead routes", () => {
  it("POST /api/leads creates a lead", async () => {
    leadCreate.mockResolvedValue({ id: "lead_1", phoneNumber: "+15551234567", status: "COLD" });

    const res = await request(app).post("/api/leads").send({ phoneNumber: "+15551234567", firstName: "Jane" });

    expect(res.status).toBe(201);
    expect(res.body.lead).toEqual({ id: "lead_1", phoneNumber: "+15551234567", status: "COLD" });
    expect(leadCreate).toHaveBeenCalledWith({ data: { phoneNumber: "+15551234567", firstName: "Jane" } });
  });

  it("POST /api/leads rejects a request missing the required phoneNumber", async () => {
    const res = await request(app).post("/api/leads").send({ firstName: "Jane" });

    expect(res.status).toBe(400);
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("GET /api/leads lists leads, filtered by status when provided", async () => {
    leadFindMany.mockResolvedValue([{ id: "lead_1", status: "HOT" }]);

    const res = await request(app).get("/api/leads?status=HOT");

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "HOT" } })
    );
  });

  it("GET /api/leads/:leadId returns 404 for an unknown lead", async () => {
    leadFindUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/leads/does-not-exist");

    expect(res.status).toBe(404);
  });

  it("GET /api/leads/:leadId returns the lead with its relations when found", async () => {
    leadFindUnique.mockResolvedValue({ id: "lead_1", calls: [], appointments: [] });

    const res = await request(app).get("/api/leads/lead_1");

    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe("lead_1");
  });

  it("PATCH /api/leads/:leadId updates lead fields", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", status: "WARM" });

    const res = await request(app).patch("/api/leads/lead_1").send({ status: "WARM" });

    expect(res.status).toBe(200);
    expect(leadUpdate).toHaveBeenCalledWith({ where: { id: "lead_1" }, data: { status: "WARM" } });
  });

  it("DELETE /api/leads/:leadId deletes the lead and returns 204", async () => {
    leadDeleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app).delete("/api/leads/lead_1");

    expect(res.status).toBe(204);
    expect(leadDeleteMany).toHaveBeenCalledWith({ where: { id: "lead_1" } });
  });

  it("DELETE /api/leads/:leadId is idempotent - repeating it on an already-deleted lead still returns 204", async () => {
    leadDeleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app).delete("/api/leads/lead_1");

    expect(res.status).toBe(204);
  });

  it("POST /api/leads/:leadId/consent grants consent with a source and timestamp", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", consentStatus: "GRANTED" });

    const res = await request(app).post("/api/leads/lead_1/consent").send({ granted: true, source: "web-form" });

    expect(res.status).toBe(200);
    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { consentStatus: "GRANTED", consentSource: "web-form", consentedAt: expect.any(Date) },
    });
  });

  it("POST /api/leads/:leadId/consent revokes consent", async () => {
    leadUpdate.mockResolvedValue({ id: "lead_1", consentStatus: "REVOKED" });

    const res = await request(app).post("/api/leads/lead_1/consent").send({ granted: false });

    expect(res.status).toBe(200);
    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead_1" },
      data: { consentStatus: "REVOKED", consentedAt: expect.any(Date) },
    });
  });

  it("POST /api/leads/:leadId/consent rejects a request missing the required granted field", async () => {
    const res = await request(app).post("/api/leads/lead_1/consent").send({ source: "web-form" });

    expect(res.status).toBe(400);
    expect(leadUpdate).not.toHaveBeenCalled();
  });
});
