const freebusyQuery = jest.fn();
const eventsInsert = jest.fn();
const eventsDelete = jest.fn();

jest.mock("./googleCalendarClient", () => ({
  getCalendarClient: () => ({
    freebusy: { query: freebusyQuery },
    events: { insert: eventsInsert, delete: eventsDelete },
  }),
}));

import { cancelAppointment, createAppointment, getBusySlots, isSlotAvailable } from "./calendarService";

describe("calendarService", () => {
  it("getBusySlots maps the freebusy response for the configured calendar", async () => {
    freebusyQuery.mockResolvedValue({
      data: {
        calendars: {
          primary: {
            busy: [{ start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z" }],
          },
        },
      },
    });

    const busy = await getBusySlots("2025-01-15T00:00:00Z", "2025-01-16T00:00:00Z");

    expect(busy).toEqual([{ start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z" }]);
    expect(freebusyQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ items: [{ id: "primary" }] }),
      })
    );
  });

  describe("isSlotAvailable", () => {
    it("returns false when the candidate window overlaps a busy slot", async () => {
      freebusyQuery.mockResolvedValue({
        data: { calendars: { primary: { busy: [{ start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z" }] } } },
      });

      const available = await isSlotAvailable("2025-01-15T14:15:00Z", "2025-01-15T14:45:00Z");
      expect(available).toBe(false);
    });

    it("returns true when the candidate window does not overlap any busy slot", async () => {
      freebusyQuery.mockResolvedValue({
        data: { calendars: { primary: { busy: [{ start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z" }] } } },
      });

      const available = await isSlotAvailable("2025-01-15T15:00:00Z", "2025-01-15T15:30:00Z");
      expect(available).toBe(true);
    });

    it("treats back-to-back slots (end == start) as available", async () => {
      freebusyQuery.mockResolvedValue({
        data: { calendars: { primary: { busy: [{ start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z" }] } } },
      });

      const available = await isSlotAvailable("2025-01-15T14:30:00Z", "2025-01-15T15:00:00Z");
      expect(available).toBe(true);
    });
  });

  it("createAppointment builds an event with UTC default timezone and returns the created event", async () => {
    eventsInsert.mockResolvedValue({
      data: {
        id: "evt_123",
        htmlLink: "https://calendar.google.com/evt_123",
        start: { dateTime: "2025-01-15T14:00:00Z" },
        end: { dateTime: "2025-01-15T14:30:00Z" },
      },
    });

    const result = await createAppointment({
      summary: "Consultation call",
      startTime: "2025-01-15T14:00:00Z",
      endTime: "2025-01-15T14:30:00Z",
      attendeeEmail: "lead@example.com",
    });

    expect(result).toEqual({
      eventId: "evt_123",
      htmlLink: "https://calendar.google.com/evt_123",
      start: "2025-01-15T14:00:00Z",
      end: "2025-01-15T14:30:00Z",
    });

    expect(eventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "primary",
        requestBody: expect.objectContaining({
          summary: "Consultation call",
          start: { dateTime: "2025-01-15T14:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2025-01-15T14:30:00Z", timeZone: "UTC" },
          attendees: [{ email: "lead@example.com" }],
        }),
      })
    );
  });

  it("cancelAppointment deletes the event by id", async () => {
    eventsDelete.mockResolvedValue({});
    await cancelAppointment("evt_123");
    expect(eventsDelete).toHaveBeenCalledWith({ calendarId: "primary", eventId: "evt_123" });
  });
});
