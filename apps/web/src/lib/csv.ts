import type { BulkCreateLeadRow, LeadStatus } from "@telephony/shared-types";
import { LeadStatusValues } from "@telephony/shared-types";

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

const KNOWN_COLUMNS = ["firstname", "lastname", "phonenumber", "email", "status", "notes"] as const;

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

    const phoneNumber = cells[phoneIdx]?.trim();
    if (!phoneNumber) {
      invalid.push({ line, reason: "Missing phone number" });
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
      if (!LeadStatusValues.includes(upper as LeadStatus)) {
        invalid.push({ line, reason: `Invalid status "${statusRaw}" (expected COLD, WARM or HOT)` });
        continue;
      }
      status = upper as LeadStatus;
    }

    valid.push({
      line,
      lead: {
        firstName: get("firstname") || undefined,
        lastName: get("lastname") || undefined,
        phoneNumber,
        email,
        status,
        notes: get("notes") || undefined,
      },
    });
  }

  return { valid, invalid };
}

/** The header + one example row shown by the "Download template" link. */
export const LEAD_CSV_TEMPLATE =
  "firstName,lastName,phoneNumber,email,status,notes\n" +
  "Jane,Doe,+15551234567,jane@example.com,WARM,Met at conference\n";
