import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createLocalUser, countAuthUsers, createAuthSession, touchAuthUserLogin } from "@/lib/auth/identity";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const BootstrapSchema = z.object({
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(12).max(256),
});

export async function POST(request: NextRequest) {
  if (countAuthUsers() > 0) {
    return NextResponse.json({ error: "Bootstrap already completed." }, { status: 409 });
  }

  const payload = BootstrapSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  let user;
  try {
    user = createLocalUser({
      username: payload.data.username,
      displayName: payload.data.displayName,
      passwordHash: hashPassword(payload.data.password),
      role: "Owner",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create bootstrap owner." },
      { status: 400 },
    );
  }

  const auth = stateStore.getAuthSettings();
  const { token, tokenHash } = createSessionToken();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const userAgent = request.headers.get("user-agent") || undefined;
  createAuthSession({
    userId: user.id,
    tokenHash,
    ttlHours: auth.sessionTtlHours,
    ip,
    userAgent,
  });
  touchAuthUserLogin(user.id);

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Initialized local Owner account",
    context: {
      username: user.username,
      role: user.role,
      provider: user.provider,
    },
  });

  const response = NextResponse.json({
    ok: true,
    user,
  });
  setSessionCookie(response, token, auth.sessionTtlHours, request.nextUrl.protocol === "https:");
  return response;
}
