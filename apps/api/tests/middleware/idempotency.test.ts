import { Prisma } from "@prisma/client";

const leadCreate = jest.fn();
const idempotencyKeyCreate = jest.fn();
const idempotencyKeyFindUnique = jest.fn();
const idempotencyKeyUpdate = jest.fn();
const idempotencyKeyDeleteMany = jest.fn();

jest.mock("@telephony/database", () => ({
  ...jest.requireActual("@prisma/client"),
  prisma: {
    lead: { create: (...args: unknown[]) => leadCreate(...args) },
    idempotencyKey: {
      create: (...args: unknown[]) => idempotencyKeyCreate(...args),
      findUnique: (...args: unknown[]) => idempotencyKeyFindUnique(...args),
      update: (...args: unknown[]) => idempotencyKeyUpdate(...args),
      deleteMany: (...args: unknown[]) => idempotencyKeyDeleteMany(...args),
    },
  },
}));

import request from "supertest";
import { createApp } from "../../src/app";

const app = createApp();

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`key`)", {
    code: "P2002",
    clientVersion: "5.22.0",
  });
}

async function flushFinishHandlers() {
  // res.on("finish") fires the (fire-and-forget) DB persistence async; give
  // its microtasks a couple ticks to settle before asserting on it.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("idempotency middleware (via POST /api/leads)", () => {
  const body = { phoneNumber: "+15551234567", firstName: "Jane" };

  it("proceeds normally when no Idempotency-Key header is sent", async () => {
    leadCreate.mockResolvedValue({ id: "lead_1", ...body });

    const res = await request(app).post("/api/leads").send(body);

    expect(res.status).toBe(201);
    expect(idempotencyKeyCreate).not.toHaveBeenCalled();
  });

  it("claims the key, runs the request, and persists the response on success", async () => {
    idempotencyKeyCreate.mockResolvedValue({ key: "key-1" });
    leadCreate.mockResolvedValue({ id: "lead_1", ...body });

    const res = await request(app).post("/api/leads").set("Idempotency-Key", "key-1").send(body);
    await flushFinishHandlers();

    expect(res.status).toBe(201);
    expect(leadCreate).toHaveBeenCalledTimes(1);
    expect(idempotencyKeyUpdate).toHaveBeenCalledWith({
      where: { key: "key-1" },
      data: expect.objectContaining({ status: "COMPLETED", responseStatus: 201 }),
    });
  });

  it("replays the cached response for a repeat request with the same key and body, without re-running the operation", async () => {
    idempotencyKeyCreate.mockRejectedValue(uniqueConstraintError());
    idempotencyKeyFindUnique.mockResolvedValue({
      key: "key-2",
      status: "COMPLETED",
      responseStatus: 201,
      responseBody: { lead: { id: "lead_1", ...body } },
      requestHash: require("crypto")
        .createHash("sha256")
        .update(`POST:/api/leads:${JSON.stringify(body)}`)
        .digest("hex"),
    });

    const res = await request(app).post("/api/leads").set("Idempotency-Key", "key-2").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ lead: { id: "lead_1", ...body } });
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("returns 409 when a request with the same key is still in flight", async () => {
    idempotencyKeyCreate.mockRejectedValue(uniqueConstraintError());
    idempotencyKeyFindUnique.mockResolvedValue({
      key: "key-3",
      status: "PENDING",
      requestHash: require("crypto")
        .createHash("sha256")
        .update(`POST:/api/leads:${JSON.stringify(body)}`)
        .digest("hex"),
    });

    const res = await request(app).post("/api/leads").set("Idempotency-Key", "key-3").send(body);

    expect(res.status).toBe(409);
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("returns 422 when the same key is reused with a different request body", async () => {
    idempotencyKeyCreate.mockRejectedValue(uniqueConstraintError());
    idempotencyKeyFindUnique.mockResolvedValue({
      key: "key-4",
      status: "COMPLETED",
      requestHash: "a-completely-different-hash",
    });

    const res = await request(app).post("/api/leads").set("Idempotency-Key", "key-4").send(body);

    expect(res.status).toBe(422);
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("releases the key on a 5xx so a genuine retry can re-attempt the operation", async () => {
    idempotencyKeyCreate.mockResolvedValue({ key: "key-5" });
    leadCreate.mockRejectedValue(new Error("DB unavailable"));

    const res = await request(app).post("/api/leads").set("Idempotency-Key", "key-5").send(body);
    await flushFinishHandlers();

    expect(res.status).toBe(500);
    expect(idempotencyKeyDeleteMany).toHaveBeenCalledWith({ where: { key: "key-5" } });
    expect(idempotencyKeyUpdate).not.toHaveBeenCalled();
  });
});
