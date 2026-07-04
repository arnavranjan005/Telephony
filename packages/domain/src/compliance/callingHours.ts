import { AREA_CODE_TIMEZONES } from "./areaCodeTimezones";

const CALLING_WINDOW_START_HOUR = 8; // 8am
const CALLING_WINDOW_END_HOUR = 21; // 9pm - TCPA's outer bound, 47 CFR 64.1200(a)(3)

/** Extracts the 3-digit NANP area code from a +1 US/Canada number, or null for anything else. */
export function getAreaCode(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  return national ? national.slice(0, 3) : null;
}

/** Looks up the IANA time zone for a phone number's area code, or null if unknown. */
export function getTimezoneForPhoneNumber(phoneNumber: string): string | null {
  const areaCode = getAreaCode(phoneNumber);
  return areaCode ? AREA_CODE_TIMEZONES[areaCode] ?? null : null;
}

function localHour(timezone: string, at: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(at)
  );
}

/**
 * True if it's currently within the legal calling window (8am-9pm) at the
 * called number's local time. Numbers whose area code isn't in
 * AREA_CODE_TIMEZONES (including all non-NANP numbers) have no determinable
 * local time, so they're treated as unrestricted rather than blocked - there's
 * no legal-hours basis to block on without knowing the recipient's time zone.
 */
export function isWithinCallingHours(phoneNumber: string, now: Date = new Date()): boolean {
  const timezone = getTimezoneForPhoneNumber(phoneNumber);
  if (!timezone) return true;

  const hour = localHour(timezone, now);
  return hour >= CALLING_WINDOW_START_HOUR && hour < CALLING_WINDOW_END_HOUR;
}

/**
 * The next instant at/after `from` when this number enters its legal calling
 * window, for rescheduling a dial that arrived outside it. Steps forward in
 * 15-minute increments and re-checks via Intl at each candidate rather than
 * computing UTC offsets/DST transitions by hand - correct by construction,
 * at the cost of up to 15 minutes of scheduling slop, which is immaterial
 * for a callback window measured in hours.
 */
export function nextCallingWindowStart(phoneNumber: string, from: Date = new Date()): Date {
  const stepMs = 15 * 60 * 1000;
  const maxSteps = Math.ceil((3 * 24 * 60 * 60 * 1000) / stepMs); // safety cap: 3 days out
  let candidate = new Date(from.getTime() + stepMs);

  for (let i = 0; i < maxSteps; i++) {
    if (isWithinCallingHours(phoneNumber, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + stepMs);
  }
  return candidate;
}
