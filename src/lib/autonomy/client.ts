"use client";

import { withClientApiToken } from "@/lib/auth/client-token";

export async function fetchClientJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, withClientApiToken(init));
  if (!response.ok) {
    const raw = await response.text();
    let message = raw || `Request failed with status ${response.status}`;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {
      // Ignore parsing errors and use raw text.
    }
    throw new Error(message);
  }

  return await response.json() as T;
}
