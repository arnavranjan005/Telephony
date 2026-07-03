"use client";

import { useEffect, useState } from "react";
import type { Lead } from "@telephony/shared-types";
import { apiClient } from "../lib/apiClient";

/**
 * Proof-of-wiring page: fetches leads from the Express API entirely in the
 * browser. This is a skeleton, not the full admin UI - a real leads table
 * (filtering, pagination, campaign/call drill-down, etc.) is future work
 * once this wiring is confirmed solid.
 */
export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .listLeads()
      .then((data) => setLeads(data.leads))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <main style={{ padding: "2rem", maxWidth: 720, margin: "0 auto" }}>
      <h1>Leads</h1>

      {error && <p style={{ color: "crimson" }}>Failed to load leads: {error}</p>}
      {!leads && !error && <p>Loading…</p>}

      {leads && leads.length === 0 && <p>No leads yet.</p>}

      {leads && leads.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Name</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Phone</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  {lead.firstName} {lead.lastName}
                </td>
                <td>{lead.phoneNumber}</td>
                <td>{lead.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
