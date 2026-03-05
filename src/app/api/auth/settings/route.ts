import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/guard";
import { getAuthSettingsWithSecretFlags, setAuthSecrets } from "@/lib/auth/settings";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const AuthSettingsSchema = z.object({
  mode: z.enum(["open", "token", "session", "hybrid"]),
  sessionTtlHours: z.number().int().min(1).max(24 * 30),
  oidc: z.object({
    enabled: z.boolean(),
    issuer: z.string().trim().max(512),
    clientId: z.string().trim().max(512),
    scopes: z.string().trim().max(512),
    autoProvision: z.boolean(),
    defaultRole: z.enum(["Owner", "Admin", "Operator", "Auditor", "ReadOnly"]),
    clientSecret: z.string().max(2048).nullable().optional(),
  }),
  ldap: z.object({
    enabled: z.boolean(),
    url: z.string().trim().max(512),
    baseDn: z.string().trim().max(512),
    bindDn: z.string().trim().max(512),
    userFilter: z.string().trim().max(512),
    uidAttribute: z.string().trim().max(128),
    autoProvision: z.boolean(),
    defaultRole: z.enum(["Owner", "Admin", "Operator", "Auditor", "ReadOnly"]),
    bindPassword: z.string().max(2048).nullable().optional(),
  }),
});

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const settings = await getAuthSettingsWithSecretFlags();
  return NextResponse.json({ settings });
}

export async function POST(request: NextRequest) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const payload = AuthSettingsSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const current = await getAuthSettingsWithSecretFlags();
  const input = payload.data;

  await setAuthSecrets({
    oidcClientSecret: input.oidc.clientSecret,
    ldapBindPassword: input.ldap.bindPassword,
  });

  const refreshed = await getAuthSettingsWithSecretFlags();
  const merged = {
    ...current,
    mode: input.mode,
    sessionTtlHours: input.sessionTtlHours,
    oidc: {
      ...refreshed.oidc,
      enabled: input.oidc.enabled,
      issuer: input.oidc.issuer,
      clientId: input.oidc.clientId,
      scopes: input.oidc.scopes,
      autoProvision: input.oidc.autoProvision,
      defaultRole: input.oidc.defaultRole,
    },
    ldap: {
      ...refreshed.ldap,
      enabled: input.ldap.enabled,
      url: input.ldap.url,
      baseDn: input.ldap.baseDn,
      bindDn: input.ldap.bindDn,
      userFilter: input.ldap.userFilter,
      uidAttribute: input.ldap.uidAttribute,
      autoProvision: input.ldap.autoProvision,
      defaultRole: input.ldap.defaultRole,
    },
  };

  stateStore.setAuthSettings(merged, { actor: "user" });
  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Updated authentication settings",
    context: {
      mode: merged.mode,
      oidcEnabled: merged.oidc.enabled,
      ldapEnabled: merged.ldap.enabled,
      actorUserId: auth.user?.id ?? null,
    },
  });

  return NextResponse.json({ ok: true, settings: await getAuthSettingsWithSecretFlags() });
}

