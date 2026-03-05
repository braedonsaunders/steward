import { NextResponse, type NextRequest } from "next/server";
import {
  consumeOidcState,
  createAuthSession,
  getAuthUserByProviderExternal,
  touchAuthUserLogin,
  upsertFederatedUser,
} from "@/lib/auth/identity";
import { exchangeOidcCode, fetchOidcDiscovery, resolveOidcUser } from "@/lib/auth/oidc";
import { createSessionToken, setSessionCookie } from "@/lib/auth/session";
import { getAuthSettingsWithSecretFlags, getOidcClientSecret } from "@/lib/auth/settings";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, origin));

  const error = request.nextUrl.searchParams.get("error");
  if (error) {
    return redirectTo(`/settings?auth_error=${encodeURIComponent(error)}`);
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return redirectTo("/settings?auth_error=missing_code_or_state");
  }

  const oidcState = consumeOidcState(state);
  if (!oidcState) {
    return redirectTo("/settings?auth_error=invalid_or_expired_state");
  }

  const settings = await getAuthSettingsWithSecretFlags();
  if (!settings.oidc.enabled || !settings.oidc.issuer || !settings.oidc.clientId) {
    return redirectTo("/settings?auth_error=oidc_not_enabled");
  }

  try {
    const discovery = await fetchOidcDiscovery(settings.oidc.issuer);
    const clientSecret = await getOidcClientSecret();
    const tokens = await exchangeOidcCode({
      discovery,
      auth: settings.oidc,
      code,
      codeVerifier: oidcState.codeVerifier,
      redirectUri: oidcState.redirectUri,
      clientSecret,
    });
    const resolved = await resolveOidcUser({
      tokens,
      discovery,
      auth: settings.oidc,
      nonce: oidcState.nonce,
    });

    let user = getAuthUserByProviderExternal("oidc", resolved.externalId);
    if (!user) {
      if (!settings.oidc.autoProvision) {
        return redirectTo("/settings?auth_error=oidc_user_not_provisioned");
      }
      user = upsertFederatedUser({
        provider: "oidc",
        externalId: resolved.externalId,
        usernameHint: resolved.usernameHint,
        displayName: resolved.displayName,
        defaultRole: settings.oidc.defaultRole,
      });
    }

    if (user.disabled) {
      return redirectTo("/settings?auth_error=account_disabled");
    }

    const { token, tokenHash } = createSessionToken();
    createAuthSession({
      userId: user.id,
      tokenHash,
      ttlHours: settings.sessionTtlHours,
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });
    touchAuthUserLogin(user.id);

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: "OIDC login completed",
      context: {
        username: user.username,
        userId: user.id,
        provider: "oidc",
      },
    });

    const response = redirectTo("/settings?auth=oidc_success");
    setSessionCookie(response, token, settings.sessionTtlHours, request.nextUrl.protocol === "https:");
    return response;
  } catch (exchangeError) {
    const msg = exchangeError instanceof Error ? exchangeError.message : "oidc_exchange_failed";
    return redirectTo(`/settings?auth_error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
}
