import { NextResponse, type NextRequest } from "next/server";
import { deleteSessionByToken } from "@/lib/auth/identity";
import { clearSessionCookie, readSessionToken } from "@/lib/auth/session";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = readSessionToken(request);
  if (token) {
    deleteSessionByToken(token);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "User logged out",
    context: {},
  });

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request.nextUrl.protocol === "https:");
  return response;
}
