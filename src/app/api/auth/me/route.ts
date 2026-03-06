import { NextResponse, type NextRequest } from "next/server";
import { getAuthContext } from "@/lib/auth/guard";
import { countAuthUsers } from "@/lib/auth/identity";
import { getAuthSettingsWithSecretFlags } from "@/lib/auth/settings";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request);
  const usersCount = countAuthUsers();
  const settings = await getAuthSettingsWithSecretFlags();
  const authenticated = Boolean(auth.user) || auth.source === "token";
  const authRequired = !auth.authorized;

  if (!authenticated) {
    return NextResponse.json({
      authenticated: false,
      authRequired,
      requiresBootstrap: usersCount === 0,
      mode: settings.mode,
      apiTokenEnabled: settings.apiTokenEnabled,
      usersCount,
    });
  }

  return NextResponse.json({
    authenticated: true,
    authRequired,
    user: auth.user,
    role: auth.role,
    source: auth.source,
    mode: settings.mode,
    requiresBootstrap: usersCount === 0,
    apiTokenEnabled: settings.apiTokenEnabled,
    usersCount,
  });
}
