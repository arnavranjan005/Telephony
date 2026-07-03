import type { Lead } from "@telephony/shared-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ? JSON.stringify(body.error) : `Request to ${path} failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

/**
 * Thin typed client over the Express API. Every call happens in the
 * browser (this file is only ever imported from client components) - the
 * admin panel has no server-side code of its own.
 */
export const apiClient = {
  listLeads: () => apiFetch<{ leads: Lead[] }>("/api/leads"),
};
