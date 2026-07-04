import {
  getAreaCode,
  getTimezoneForPhoneNumber,
  isWithinCallingHours,
  nextCallingWindowStart,
} from "./callingHours";

describe("getAreaCode", () => {
  it("extracts the area code from a +1 E.164 number", () => {
    expect(getAreaCode("+12125551234")).toBe("212");
  });

  it("extracts the area code from a bare 10-digit number", () => {
    expect(getAreaCode("2125551234")).toBe("212");
  });

  it("returns null for a non-NANP-shaped number", () => {
    expect(getAreaCode("+442071234567")).toBeNull();
  });
});

describe("getTimezoneForPhoneNumber", () => {
  it("resolves a known area code to its IANA time zone", () => {
    expect(getTimezoneForPhoneNumber("+12125551234")).toBe("America/New_York"); // NYC
    expect(getTimezoneForPhoneNumber("+13105551234")).toBe("America/Los_Angeles"); // LA
    expect(getTimezoneForPhoneNumber("+16025551234")).toBe("America/Phoenix"); // Phoenix
  });

  it("returns null for an unrecognized/fictional area code", () => {
    expect(getTimezoneForPhoneNumber("+15555551234")).toBeNull(); // 555 is reserved for fictional use
  });
});

describe("isWithinCallingHours", () => {
  it("is true for a number with no known time zone, regardless of the current time", () => {
    const midnight = new Date("2026-01-01T00:00:00Z");
    expect(isWithinCallingHours("+15555551234", midnight)).toBe(true);
  });

  it("is true at 8am local time (the start of the window)", () => {
    // 13:00 UTC = 8:00am America/New_York (EST, UTC-5) in January
    const at8am = new Date("2026-01-15T13:00:00Z");
    expect(isWithinCallingHours("+12125551234", at8am)).toBe(true);
  });

  it("is false just before 8am local time", () => {
    const at759am = new Date("2026-01-15T12:59:00Z");
    expect(isWithinCallingHours("+12125551234", at759am)).toBe(false);
  });

  it("is true just before 9pm local time", () => {
    // 01:59 UTC = 8:59pm America/New_York (EST) the prior day
    const at859pm = new Date("2026-01-16T01:59:00Z");
    expect(isWithinCallingHours("+12125551234", at859pm)).toBe(true);
  });

  it("is false at 9pm local time (the end of the window)", () => {
    const at9pm = new Date("2026-01-16T02:00:00Z");
    expect(isWithinCallingHours("+12125551234", at9pm)).toBe(false);
  });

  it("is false in the middle of the night", () => {
    const at2am = new Date("2026-01-15T07:00:00Z"); // 2am America/New_York
    expect(isWithinCallingHours("+12125551234", at2am)).toBe(false);
  });
});

describe("nextCallingWindowStart", () => {
  it("returns the same day's 8am when the current local time is before it", () => {
    const at2am = new Date("2026-01-15T07:00:00Z"); // 2am America/New_York
    const next = nextCallingWindowStart("+12125551234", at2am);

    expect(isWithinCallingHours("+12125551234", next)).toBe(true);
    expect(next.getTime()).toBeLessThan(new Date("2026-01-15T13:15:00Z").getTime());
  });

  it("returns the next day's 8am when the current local time is after 9pm", () => {
    const at10pm = new Date("2026-01-16T03:00:00Z"); // 10pm America/New_York
    const next = nextCallingWindowStart("+12125551234", at10pm);

    expect(isWithinCallingHours("+12125551234", next)).toBe(true);
    // Should have rolled over to the next calendar day's window, not the same day.
    expect(next.getTime()).toBeGreaterThan(new Date("2026-01-16T13:00:00Z").getTime() - 1);
  });
});
