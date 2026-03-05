import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createOidcState } from "@/lib/auth/identity";
import {
  buildOidcAuthorizeUrl,
  fetchOidcDiscovery,
  pkceCodeChallenge,
  randomBase64Url,
} from "@/lib/auth/oidc";
import { getAuthSettingsWithSecretFlags } from "@/lib/auth/settings";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const settings = await getAuthSettingsWithSecretFlags();
  if (!settings.oidc.enabled) {
    return NextResponse.json({ error: "OIDC login is disabled." }, { status: 400 });
  }
  if (!settings.oidc.issuer || !settings.oidc.clientId) {
    return NextResponse.json({ error: "OIDC settings are incomplete." }, { status: 400 });
  }

  let discovery;
  try {
    discovery = await fetchOidcDiscovery(settings.oidc.issuer);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "OIDC discovery failed." },
      { status: 400 },
    );
  }

  const redirectUri = `${request.nextUrl.origin}/api/auth/oidc/callback`;
  const stateId = randomUUID();
  const codeVerifier = randomBase64Url(48);
  const nonce = randomBase64Url(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  createOidcState({
    id: stateId,
    codeVerifier,
    nonce,
    redirectUri,
    expiresAt,
  });

  const authorizeUrl = buildOidcAuthorizeUrl({
    discovery,
    auth: settings.oidc,
    redirectUri,
    state: stateId,
    nonce,
    codeChallenge: pkceCodeChallenge(codeVerifier),
  });

  return NextResponse.json({
    ok: true,
    authorizeUrl,
  });
}

