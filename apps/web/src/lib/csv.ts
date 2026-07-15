import type { BulkCreateLeadRow, LeadStatus } from "@telephony/shared-types";

// Kept local (not imported from @telephony/shared-types) on purpose: the web
// app only takes type-only imports from shared-types, which tsc/SWC erase, so
// `npm run dev:web` works on a fresh clone without first building the package.
// A runtime value import would resolve to shared-types' built dist/ and break
// dev until that build ran. Source of truth for these values is
// LeadStatusValues in @telephony/shared-types.
const LEAD_STATUS_VALUES: LeadStatus[] = ["COLD", "WARM", "HOT"];

// Same reasoning as above - duplicated rather than imported at runtime.
// Source of truth is sanitizePhoneNumber/isE164 in @telephony/shared-types.
function sanitizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
function isE164(phoneNumber: string): boolean {
  return E164_PATTERN.test(phoneNumber);
}

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, commas and
 * newlines inside quotes, and "" escaped quotes. Enough for the lead-import
 * dialog without pulling in a dependency. Returns a matrix of raw string
 * cells (header row included).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalize BOM so a spreadsheet-exported file's first header isn't
  // silently prefixed with an invisible ﻿.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Consume \r\n as a single break.
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // Flush the trailing field/row (files without a final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export interface ParsedLeadRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  lead: BulkCreateLeadRow;
}

export interface CsvParseResult {
  valid: ParsedLeadRow[];
  /** Rows dropped before upload with a human-readable reason. */
  invalid: Array<{ line: number; reason: string }>;
}

const KNOWN_COLUMNS = ["name", "phonenumber", "email", "status", "notes", "niche", "address", "state", "website"] as const;

/** Folds niche/address/state/website (common in scraped B2B lead lists,
 * e.g. Google Maps exports) into the lead's notes, since we don't have
 * dedicated columns for them - rather than silently dropping that context,
 * it's the only record of what business this is and where, which the AI
 * agent can otherwise use via get_lead_details. Appended after any
 * hand-written `notes` value rather than replacing it. */
function buildNotes(get: (col: (typeof KNOWN_COLUMNS)[number]) => string | undefined): string | undefined {
  const context = [get("niche"), get("address"), get("state"), get("website")].filter(Boolean).join(" · ");
  const manual = get("notes");
  if (manual && context) return `${manual} (${context})`;
  return manual || context || undefined;
}

/** Maps a header cell to our canonical column key, tolerating spaces,
 * underscores and casing ("First Name", "phone_number", "PhoneNumber"). */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_]+/g, "");
}

/**
 * Turns raw CSV text into validated lead rows ready for the bulk endpoint.
 * The only required column is a non-empty phone number; everything else is
 * optional. Unknown columns are ignored, and rows are validated against the
 * same field rules the API enforces.
 */
export function parseLeadsCsv(text: string): CsvParseResult {
  const matrix = parseCsv(text).filter((r) => r.some((cell) => cell.trim() !== ""));
  if (matrix.length === 0) return { valid: [], invalid: [] };

  const headers = matrix[0].map(normalizeHeader);
  const phoneIdx = headers.indexOf("phonenumber");

  const valid: ParsedLeadRow[] = [];
  const invalid: Array<{ line: number; reason: string }> = [];

  if (phoneIdx === -1) {
    return { valid: [], invalid: [{ line: 1, reason: "Missing required 'phoneNumber' column in header row" }] };
  }

  for (let i = 1; i < matrix.length; i++) {
    const cells = matrix[i];
    const line = i + 1;
    const get = (col: (typeof KNOWN_COLUMNS)[number]) => {
      const idx = headers.indexOf(col);
      return idx === -1 ? undefined : cells[idx]?.trim();
    };

    const rawPhoneNumber = cells[phoneIdx]?.trim();
    if (!rawPhoneNumber) {
      invalid.push({ line, reason: "Missing phone number" });
      continue;
    }
    const phoneNumber = sanitizePhoneNumber(rawPhoneNumber);
    if (!isE164(phoneNumber)) {
      invalid.push({
        line,
        reason: `Invalid phone number "${rawPhoneNumber}" (expected E.164, e.g. +15551234567)`,
      });
      continue;
    }

    const email = get("email") || undefined;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      invalid.push({ line, reason: `Invalid email "${email}"` });
      continue;
    }

    const statusRaw = get("status");
    let status: LeadStatus | undefined;
    if (statusRaw) {
      const upper = statusRaw.toUpperCase();
      if (!LEAD_STATUS_VALUES.includes(upper as LeadStatus)) {
        invalid.push({ line, reason: `Invalid status "${statusRaw}" (expected COLD, WARM or HOT)` });
        continue;
      }
      status = upper as LeadStatus;
    }

    valid.push({
      line,
      lead: {
        name: get("name") || undefined,
        phoneNumber,
        email,
        status,
        notes: buildNotes(get),
      },
    });
  }

  return { valid, invalid };
}

/** The header + example rows shown by the "Download template" link. niche/
 * address/state/website are optional B2B-lead columns (e.g. from a scraped
 * Google Maps export) folded into notes on import - see buildNotes above. */
export const LEAD_CSV_TEMPLATE =
  "name,phoneNumber,email,status,notes,niche,address,state,website\n" +
  "Jane Doe,+15551234567,jane@example.com,WARM,Met at conference,,,,\n" +
  "Daigle Roofing and Construction,+13373686335,,COLD,,Roofers,\"123 Main St, Dulac, LA\",Louisiana,daigleroofing.com\n";
