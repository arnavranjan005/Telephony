const listDnc = jest.fn();
const addToDnc = jest.fn();
const removeFromDnc = jest.fn();

jest.mock("../../src/lib/compliance/dncService", () => ({
  listDnc: (...args: unknown[]) => listDnc(...args),
  addToDnc: (...args: unknown[]) => addToDnc(...args),
  removeFromDnc: (...args: unknown[]) => removeFromDnc(...args),
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

describe("DNC routes", () => {
  it("GET /api/dnc lists entries", async () => {
    listDnc.mockResolvedValue([{ id: "dnc_1", phoneNumber: "+15551234567" }]);
    const res = await request(app).get("/api/dnc");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it("POST /api/dnc adds an entry", async () => {
    addToDnc.mockResolvedValue({ id: "dnc_1", phoneNumber: "+15551234567" });

    const res = await request(app).post("/api/dnc").send({ phoneNumber: "+15551234567", reason: "requested" });

    expect(res.status).toBe(201);
    expect(addToDnc).toHaveBeenCalledWith("+15551234567", "requested");
  });

  it("POST /api/dnc rejects a request missing phoneNumber", async () => {
    const res = await request(app).post("/api/dnc").send({ reason: "requested" });
    expect(res.status).toBe(400);
    expect(addToDnc).not.toHaveBeenCalled();
  });

  it("DELETE /api/dnc/:phoneNumber removes an entry", async () => {
    removeFromDnc.mockResolvedValue(undefined);
    const res = await request(app).delete("/api/dnc/+15551234567");
    expect(res.status).toBe(204);
    expect(removeFromDnc).toHaveBeenCalledWith("+15551234567");
  });
});
