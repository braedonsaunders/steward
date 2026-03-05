import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateViaLdap } from "@/lib/auth/ldap";
import {
  createAuthSession,
  getAuthUserByProviderExternal,
  touchAuthUserLogin,
  upsertFederatedUser,
  verifyLocalLogin,
} from "@/lib/auth/identity";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { getAuthSettingsWithSecretFlags, getLdapBindPassword } from "@/lib/auth/settings";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const LoginSchema = z.object({
  method: z.enum(["local", "ldap"]).optional().default("local"),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
});

export async function POST(request: NextRequest) {
  const payload = LoginSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const authSettings = await getAuthSettingsWithSecretFlags();
  const { method, username, password } = payload.data;

  let user = null;
  if (method === "local") {
    user = verifyLocalLogin(username, password);
    if (!user) {
      return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
    }
  } else {
    if (!authSettings.ldap.enabled) {
      return NextResponse.json({ error: "LDAP login is not enabled." }, { status: 400 });
    }

    try {
      const bindPassword = await getLdapBindPassword();
      const resolved = await authenticateViaLdap(authSettings.ldap, username, password, bindPassword);
      user = getAuthUserByProviderExternal("ldap", resolved.externalId);
      if (!user) {
        if (!authSettings.ldap.autoProvision) {
          return NextResponse.json({ error: "LDAP user is not provisioned." }, { status: 403 });
        }
        user = upsertFederatedUser({
          provider: "ldap",
          externalId: resolved.externalId,
          usernameHint: resolved.usernameHint,
          displayName: resolved.displayName,
          defaultRole: authSettings.ldap.defaultRole,
        });
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "LDAP authentication failed." },
        { status: 401 },
      );
    }
  }

  if (!user || user.disabled) {
    return NextResponse.json({ error: "Account is disabled." }, { status: 403 });
  }

  const { token, tokenHash } = createSessionToken();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const userAgent = request.headers.get("user-agent") || undefined;
  createAuthSession({
    userId: user.id,
    tokenHash,
    ttlHours: authSettings.sessionTtlHours,
    ip,
    userAgent,
  });
  touchAuthUserLogin(user.id);

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "User logged in",
    context: {
      username: user.username,
      provider: method,
    },
  });

  const response = NextResponse.json({
    ok: true,
    user,
  });
  setSessionCookie(
    response,
    token,
    authSettings.sessionTtlHours,
    request.nextUrl.protocol === "https:",
  );
  return response;
}
