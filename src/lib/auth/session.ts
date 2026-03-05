import { randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { hashApiToken } from "@/lib/auth/token";

export const STEWARD_SESSION_COOKIE = "steward_session";

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashApiToken(token) };
}

export function readSessionToken(request: NextRequest): string | null {
  return request.cookies.get(STEWARD_SESSION_COOKIE)?.value ?? null;
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  ttlHours: number,
  secure = false,
): void {
  const maxAge = Math.max(60, Math.floor(ttlHours * 60 * 60));
  response.cookies.set(STEWARD_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  });
}

export function clearSessionCookie(response: NextResponse, secure = false): void {
  response.cookies.set(STEWARD_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  });
}
