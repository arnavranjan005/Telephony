// Bulk lead import e2e: boots the real Express app against real Postgres and
// drives POST /api/leads/bulk. Nothing is mocked here - the whole point is to
// prove the single createMany insert, the skipDuplicates behavior, and that
// the batch consent toggle writes GRANTED at create time (not via a later
// update) against a real database and its unique phoneNumber constraint.

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, ConsentStatus } from "@telephony/database";
import { BULK_IMPORT_MAX_ROWS } from "@telephony/shared-types";

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

describe("bulk lead import e2e (real Postgres)", () => {
  it("imports every row in a single request and reports the created count", async () => {
    const leads = [
      { firstName: "Jane", lastName: "Doe", phoneNumber: "+15551230001", email: "jane@example.com" },
      { firstName: "John", phoneNumber: "+15551230002", status: "WARM" as const },
      { phoneNumber: "+15551230003", notes: "no name" },
    ];

    const res = await request(app).post("/api/leads/bulk").send({ leads });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 3, skippedDuplicates: 0, duplicatesInFile: 0 });

    const rows = await prisma.lead.findMany({ orderBy: { phoneNumber: "asc" } });
    expect(rows).toHaveLength(3);
    // Fields are persisted, and status defaults to COLD when not supplied.
    expect(rows[0]).toMatchObject({ firstName: "Jane", email: "jane@example.com", status: "COLD" });
    expect(rows[1]).toMatchObject({ firstName: "John", status: "WARM" });
    // Without the batch toggle, consent stays UNKNOWN.
    expect(rows.every((r) => r.consentStatus === ConsentStatus.UNKNOWN)).toBe(true);
  });

  it("consentGrantedAll marks every imported lead GRANTED at create time", async () => {
    const leads = [{ phoneNumber: "+15552220001" }, { phoneNumber: "+15552220002" }];

    const res = await request(app).post("/api/leads/bulk").send({ leads, consentGrantedAll: true });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);

    const rows = await prisma.lead.findMany();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.consentStatus).toBe(ConsentStatus.GRANTED);
      expect(row.consentSource).toBe("admin_panel");
      // consentedAt is set in the same write, not left null for a follow-up update.
      expect(row.consentedAt).toBeInstanceOf(Date);
    }
  });

  it("skips rows whose phone number already exists instead of failing the batch", async () => {
    await prisma.lead.create({ data: { phoneNumber: "+15553330001" } });

    const leads = [
      { phoneNumber: "+15553330001" }, // already in DB
      { phoneNumber: "+15553330002" }, // new
      { phoneNumber: "+15553330003" }, // new
    ];
    const res = await request(app).post("/api/leads/bulk").send({ leads });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 2, skippedDuplicates: 1, duplicatesInFile: 0 });
    expect(await prisma.lead.count()).toBe(3);
  });

  it("de-dupes rows that collide within the same file", async () => {
    const leads = [
      { firstName: "First", phoneNumber: "+15554440001" },
      { firstName: "Dup", phoneNumber: "+15554440001" }, // same number, dropped
      { phoneNumber: "+15554440002" },
    ];
    const res = await request(app).post("/api/leads/bulk").send({ leads });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 2, skippedDuplicates: 0, duplicatesInFile: 1 });

    // The first occurrence wins.
    const kept = await prisma.lead.findUniqueOrThrow({ where: { phoneNumber: "+15554440001" } });
    expect(kept.firstName).toBe("First");
  });

  it("rejects an empty batch and a batch over the row cap", async () => {
    const empty = await request(app).post("/api/leads/bulk").send({ leads: [] });
    expect(empty.status).toBe(400);

    const tooMany = await request(app)
      .post("/api/leads/bulk")
      .send({ leads: Array.from({ length: BULK_IMPORT_MAX_ROWS + 1 }, (_, i) => ({ phoneNumber: `+1666${String(i).padStart(7, "0")}` })) });
    expect(tooMany.status).toBe(400);
    expect(await prisma.lead.count()).toBe(0);
  });
});
