import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/guard";
import { authenticateViaLdap, testLdapConnection } from "@/lib/auth/ldap";
import { getAuthSettingsWithSecretFlags, getLdapBindPassword } from "@/lib/auth/settings";

export const runtime = "nodejs";

const TestSchema = z.object({
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(1).max(256).optional(),
});

export async function POST(request: NextRequest) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const payload = TestSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const settings = await getAuthSettingsWithSecretFlags();
  if (!settings.ldap.enabled) {
    return NextResponse.json({ error: "LDAP is disabled." }, { status: 400 });
  }

  const bindPassword = await getLdapBindPassword();

  if (payload.data.username && payload.data.password) {
    try {
      const resolved = await authenticateViaLdap(
        settings.ldap,
        payload.data.username,
        payload.data.password,
        bindPassword,
      );
      return NextResponse.json({ ok: true, mode: "user-auth", user: resolved });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "LDAP user auth failed." },
        { status: 400 },
      );
    }
  }

  const result = await testLdapConnection(settings.ldap, bindPassword);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}

