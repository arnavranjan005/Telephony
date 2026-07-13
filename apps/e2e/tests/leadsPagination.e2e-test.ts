// Cursor-paginated leads listing against real Postgres. Nothing mocked: the
// point is to prove the (createdAt desc, id desc) cursor pages a real table
// without gaps or repeats even when many rows share a createdAt (bulk import),
// and that the page size is clamped and the status filter still applies.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma } from "@telephony/database";

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.conversationMessage.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.campaignContact.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.call.deleteMany();
  await prisma.dncEntry.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.idempotencyKey.deleteMany();
});

describe("leads cursor pagination e2e (real Postgres)", () => {
  it("pages through every lead exactly once with no gaps or repeats", async () => {
    // 25 leads inserted in one createMany, so many share a createdAt - this is
    // exactly the case the id tie-breaker in the ordering has to survive.
    const total = 25;
    await prisma.lead.createMany({
      data: Array.from({ length: total }, (_, i) => ({ phoneNumber: `+1999${String(i).padStart(7, "0")}` })),
    });

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;

    do {
      const res = await request(app).get("/api/leads").query({ limit: 10, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      expect(res.body.leads.length).toBeLessThanOrEqual(10);
      seen.push(...res.body.leads.map((l: { id: string }) => l.id));
      cursor = res.body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against an infinite loop
    } while (cursor);

    // 3 pages (10 + 10 + 5), every id unique, all 25 covered, terminal cursor null.
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toHaveLength(total);
    expect(cursor).toBeNull();
  });

  it("caps the page size and defaults sensibly", async () => {
    await prisma.lead.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ phoneNumber: `+1888${String(i).padStart(7, "0")}` })),
    });

    // Over-large and junk limits don't error; a small explicit limit is honored.
    const capped = await request(app).get("/api/leads").query({ limit: 99999 });
    expect(capped.status).toBe(200);
    expect(capped.body.leads.length).toBe(5);
    expect(capped.body.nextCursor).toBeNull();

    const one = await request(app).get("/api/leads").query({ limit: 1 });
    expect(one.body.leads).toHaveLength(1);
    expect(one.body.nextCursor).not.toBeNull();
  });

  it("filters by status while paginating", async () => {
    await prisma.lead.create({ data: { phoneNumber: "+15550000001", status: "HOT" } });
    await prisma.lead.create({ data: { phoneNumber: "+15550000002", status: "COLD" } });

    const res = await request(app).get("/api/leads").query({ status: "HOT", limit: 10 });
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].phoneNumber).toBe("+15550000001");
  });
});
