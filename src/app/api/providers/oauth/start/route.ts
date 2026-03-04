import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import {
  buildOAuthAuthorizeUrl,
  buildOpenRouterAuthorizeUrl,
  createPkcePair,
  getProviderOAuthSettings,
  isOpenRouterOAuth,
  providerSupportsOAuth,
} from "@/lib/auth/oauth";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vaultGate = await ensureVaultReadyForProviders();
  if (!vaultGate.ok) {
    return NextResponse.json(
      { error: vaultGate.error },
      { status: 409 },
    );
  }

  const provider = request.nextUrl.searchParams.get("provider") as LLMProvider | null;

  if (!provider) {
    return NextResponse.json({ error: "Missing provider parameter" }, { status: 400 });
  }

  if (!providerSupportsOAuth(provider)) {
    return NextResponse.json(
      { error: `Provider "${provider}" does not support OAuth. Use an API key instead.` },
      { status: 400 },
    );
  }

  try {
    const { verifier, challenge } = createPkcePair();
    const redirectUri = `${request.nextUrl.origin}/api/providers/oauth/callback/${provider}`;

    const state = await stateStore.createOAuthState({
      provider,
      redirectUri,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    let authorizeUrl: string;

    if (isOpenRouterOAuth(provider)) {
      // OpenRouter has a custom auth flow — no client_id needed, different URL params
      authorizeUrl = buildOpenRouterAuthorizeUrl(redirectUri, challenge);
    } else {
      // Standard OAuth 2.0 + PKCE (Google)
      const settings = await getProviderOAuthSettings(provider);
      authorizeUrl = buildOAuthAuthorizeUrl(settings, redirectUri, state.id, challenge);
    }

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: `Started OAuth flow for ${provider}`,
      context: { provider, stateId: state.id },
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
