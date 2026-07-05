// Appointment-scheduling e2e test: boots the real Express app against real
// Postgres (docker-compose.yml, `npm run e2e:up`) and drives the real
// /api/calendar and /api/appointments routes with real HTTP requests. Only
// `googleapis` is mocked (it needs a live OAuth-authorized Google account) -
// googleCalendarClient.ts, calendarService.ts, the availability/overlap
// check, the appointmentController's compensating-delete-on-DB-failure
// logic, and the real Idempotency-Key middleware (backed by the real
// IdempotencyKey table) all run unmocked. This is the only place in the
// repo that proves booking/cancellation actually persists correctly against
// real Postgres, not just a mocked Prisma client.

const freebusyQuery = jest.fn();
const eventsInsert = jest.fn();
const eventsDelete = jest.fn();

jest.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        generateAuthUrl: jest.fn(() => "https://accounts.google.com/mock-auth-url"),
        getToken: jest.fn(async () => ({ tokens: { refresh_token: "mock-refresh-token" } })),
      })),
    },
    calendar: jest.fn(() => ({
      freebusy: { query: freebusyQuery },
      events: { insert: eventsInsert, delete: eventsDelete },
    })),
  },
}));

import request from "supertest";
import { createApp } from "../../api/src/app";
import { prisma, AppointmentStatus } from "@telephony/database";
import { dialQueue } from "@telephony/queue";

const app = createApp();

function mockNoConflict() {
  freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } });
}

function mockConflict(start: string, end: string) {
  freebusyQuery.mockResolvedValue({ data: { calendars: { primary: { busy: [{ start, end }] } } } });
}

function mockEventInsert(eventId: string, start: string, end: string) {
  eventsInsert.mockResolvedValue({
    data: { id: eventId, htmlLink: `https://calendar.google.com/${eventId}`, start: { dateTime: start }, end: { dateTime: end } },
  });
}

afterAll(async () => {
  // Obliterate (not just close) - the "dial" queue/rate-limiter state lives in
  // Redis, shared by every *.e2e-test.ts file within one --runInBand run, so
  // leftover jobs from this file could otherwise bleed into the next file's
  // tests (competing for rate-limiter throughput, or racing a later
  // beforeEach's cleanup of the Postgres rows they still reference).
  await dialQueue.obliterate({ force: true });
  await dialQueue.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  freebusyQuery.mockReset();
  eventsInsert.mockReset();
  eventsDelete.mockReset();
  eventsDelete.mockResolvedValue({});
  // Clean slate per test - order matters for FK constraints. This cleans
  // every table any *.e2e-test.ts file writes to (not just the ones this
  // file uses), because all e2e files share one database within a single
  // `--runInBand` run - a row left behind by another file's last test would
  // otherwise violate a FK constraint here.
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

describe("appointment scheduling e2e (real Postgres, mocked Google Calendar SDK)", () => {
  it("returns real-API busy slots sourced from the mocked Google Calendar freebusy query", async () => {
    freebusyQuery.mockResolvedValue({
      data: { calendars: { primary: { busy: [{ start: "2026-08-01T14:00:00Z", end: "2026-08-01T14:30:00Z" }] } } },
    });

    const res = await request(app)
      .get("/api/calendar/busy")
      .query({ timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-08-02T00:00:00Z" });

    expect(res.status).toBe(200);
    expect(res.body.busy).toEqual([{ start: "2026-08-01T14:00:00Z", end: "2026-08-01T14:30:00Z" }]);
    expect(freebusyQuery).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ items: [{ id: "primary" }] }) })
    );
  });

  it("books an appointment through the real API when the slot is free, persisting the Google event id in Postgres", async () => {
    mockNoConflict();
    mockEventInsert("evt_e2e_booked", "2026-08-01T14:00:00Z", "2026-08-01T14:30:00Z");

    const leadRes = await request(app).post("/api/leads").send({ phoneNumber: "+15551230000" });
    const leadId = leadRes.body.lead.id;

    const res = await request(app).post("/api/calendar/appointments").send({
      title: "Consultation call",
      startTime: "2026-08-01T14:00:00Z",
      endTime: "2026-08-01T14:30:00Z",
      leadId,
      attendeeEmail: "lead@example.com",
    });

    expect(res.status).toBe(201);
    expect(res.body.appointment.googleEventId).toBe("evt_e2e_booked");
    expect(eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          summary: "Consultation call",
          attendees: [{ email: "lead@example.com" }],
        }),
      })
    );

    const inDb = await prisma.appointment.findUnique({ where: { id: res.body.appointment.id } });
    expect(inDb?.googleEventId).toBe("evt_e2e_booked");
    expect(inDb?.leadId).toBe(leadId);
    expect(inDb?.status).toBe(AppointmentStatus.SCHEDULED);
  });

  it("rejects booking with 409 when the calendar reports a conflicting busy slot, and never writes a DB row", async () => {
    mockConflict("2026-08-01T14:00:00Z", "2026-08-01T14:30:00Z");

    const res = await request(app).post("/api/calendar/appointments").send({
      title: "Double-booked slot",
      startTime: "2026-08-01T14:15:00Z",
      endTime: "2026-08-01T14:45:00Z",
    });

    expect(res.status).toBe(409);
    expect(eventsInsert).not.toHaveBeenCalled();

    const appointments = await prisma.appointment.findMany({ where: { title: "Double-booked slot" } });
    expect(appointments).toHaveLength(0);
  });

  it("replays the cached response for a repeated Idempotency-Key instead of double-booking", async () => {
    mockNoConflict();
    mockEventInsert("evt_e2e_idempotent", "2026-08-02T09:00:00Z", "2026-08-02T09:30:00Z");

    const body = { title: "Follow-up consult", startTime: "2026-08-02T09:00:00Z", endTime: "2026-08-02T09:30:00Z" };

    const first = await request(app).post("/api/calendar/appointments").set("Idempotency-Key", "book-e2e-1").send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/calendar/appointments").set("Idempotency-Key", "book-e2e-1").send(body);
    expect(second.status).toBe(201);
    expect(second.body.appointment.id).toBe(first.body.appointment.id);

    expect(eventsInsert).toHaveBeenCalledTimes(1);

    const appointments = await prisma.appointment.findMany({ where: { title: "Follow-up consult" } });
    expect(appointments).toHaveLength(1);
  });

  it("cancels a booked appointment through the real API, deleting the Google Calendar event and updating Postgres", async () => {
    mockNoConflict();
    mockEventInsert("evt_e2e_to_cancel", "2026-08-03T10:00:00Z", "2026-08-03T10:30:00Z");

    const bookRes = await request(app).post("/api/calendar/appointments").send({
      title: "Cancel me",
      startTime: "2026-08-03T10:00:00Z",
      endTime: "2026-08-03T10:30:00Z",
    });
    const appointmentId = bookRes.body.appointment.id;

    const cancelRes = await request(app).post(`/api/appointments/${appointmentId}/cancel`);

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.appointment.status).toBe(AppointmentStatus.CANCELED);
    expect(eventsDelete).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "evt_e2e_to_cancel",
      sendUpdates: "all",
    });

    const inDb = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    expect(inDb?.status).toBe(AppointmentStatus.CANCELED);

    // Canceling again must be a no-op that returns the current state rather
    // than re-invoking Google's delete API on an event that's already gone.
    eventsDelete.mockClear();
    const secondCancel = await request(app).post(`/api/appointments/${appointmentId}/cancel`);
    expect(secondCancel.status).toBe(200);
    expect(eventsDelete).not.toHaveBeenCalled();
  });
});
