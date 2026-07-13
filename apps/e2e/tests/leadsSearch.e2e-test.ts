// Server-side lead search (GET /api/leads?search=) against real Postgres.
// The campaign lead picker relies on this to find any lead across the whole
// table by name or number - proving the OR match on firstName/lastName/
// phoneNumber, case-insensitivity, and that search composes with status and
// cursor pagination.

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

async function seed() {
  await prisma.lead.create({ data: { firstName: "Jane", lastName: "Doe", phoneNumber: "+15551230001" } });
  await prisma.lead.create({ data: { firstName: "Jane", lastName: "Smith", phoneNumber: "+15559990002" } });
  await prisma.lead.create({ data: { firstName: "Bob", lastName: "Jones", phoneNumber: "+15551230003" } });
}

describe("leads search e2e (real Postgres)", () => {
  it("matches by first name, case-insensitively, returning every match", async () => {
    await seed();
    const res = await request(app).get("/api/leads").query({ search: "jane" });
    expect(res.status).toBe(200);
    const names = res.body.leads.map((l: { lastName: string }) => l.lastName).sort();
    // Both Janes come back (same first name, different phone) - the picker
    // disambiguates them by the phone number it shows.
    expect(names).toEqual(["Doe", "Smith"]);
  });

  it("matches by last name and by a phone-number fragment", async () => {
    await seed();

    const byLast = await request(app).get("/api/leads").query({ search: "jones" });
    expect(byLast.body.leads).toHaveLength(1);
    expect(byLast.body.leads[0].firstName).toBe("Bob");

    // "123" appears in two of the three numbers.
    const byPhone = await request(app).get("/api/leads").query({ search: "123" });
    expect(byPhone.body.leads.map((l: { phoneNumber: string }) => l.phoneNumber).sort()).toEqual([
      "+15551230001",
      "+15551230003",
    ]);
  });

  it("returns nothing for a non-matching query", async () => {
    await seed();
    const res = await request(app).get("/api/leads").query({ search: "zzz-nobody" });
    expect(res.body.leads).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });

  it("composes search with the status filter", async () => {
    await prisma.lead.create({ data: { firstName: "Jane", phoneNumber: "+15551110001", status: "HOT" } });
    await prisma.lead.create({ data: { firstName: "Jane", phoneNumber: "+15551110002", status: "COLD" } });

    const res = await request(app).get("/api/leads").query({ search: "jane", status: "HOT" });
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].phoneNumber).toBe("+15551110001");
  });

  it("paginates a search result set with a cursor", async () => {
    // 5 leads all matching "match", paged 2 at a time.
    await prisma.lead.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        firstName: "Match",
        phoneNumber: `+1444${String(i).padStart(7, "0")}`,
      })),
    });

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const res = await request(app)
        .get("/api/leads")
        .query({ search: "match", limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.leads.map((l: { id: string }) => l.id));
      cursor = res.body.nextCursor;
      expect(++pages).toBeLessThan(6);
    } while (cursor);

    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3); // 2 + 2 + 1
  });
});
