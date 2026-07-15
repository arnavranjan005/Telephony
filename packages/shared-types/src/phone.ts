import { z } from "zod";

/** Strips everything but a leading + and digits (spaces, dashes, dots,
 * parens). Doesn't infer or add a country code - a bare national number
 * (e.g. "337-368-6335") comes out with no leading +, which then fails
 * isE164 below rather than silently being guessed at as +1. */
export function sanitizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** E.164: a leading +, a non-zero first digit, up to 15 digits total. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

export function isE164(phoneNumber: string): boolean {
  return E164_PATTERN.test(phoneNumber);
}

/** Sanitizes then requires strict E.164 - anything else (missing country
 * code, too few/many digits) fails validation rather than being imported or
 * dialed in a form Telnyx and our own calling-hours/DNC matching can't rely
 * on being consistent. */
export const phoneNumberSchema = z
  .string()
  .transform((value) => sanitizePhoneNumber(value))
  .refine((value) => isE164(value), {
    message: "Phone number must be a valid E.164 number, e.g. +15551234567",
  });
