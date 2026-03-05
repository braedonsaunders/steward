import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeOAuthCode,
  exchangeOpenRouterCode,
  getProviderOAuthSettings,
  isOpenRouterOAuth,
  providerSupportsOAuth,
} from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import { listProviderModelsFromApi, normalizeProviderModel } from "@/lib/llm/models";
import { getProviderMeta } from "@/lib/llm/registry";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const params = await context.params;
  const provider = params.provider as LLMProvider;

  const vaultGate = await ensureVaultReadyForProviders();
  if (!vaultGate.ok) {
    return NextResponse.redirect(
      new URL(
        `/settings?oauth=error&provider=${provider}&reason=${encodeURIComponent(vaultGate.error)}`,
        request.url,
      ),
    );
  }

  if (!providerSupportsOAuth(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const stateParam = request.nextUrl.searchParams.get("state");
  const errorParam = request.nextUrl.searchParams.get("error");

  if (errorParam) {
    return NextResponse.redirect(
      new URL(
        `/settings?oauth=error&provider=${provider}&reason=${encodeURIComponent(errorParam)}`,
        request.url,
      ),
    );
  }

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  // For OpenRouter, state param may not be present (it uses callback_url pattern)
  // For standard OAuth, state is required
  let codeVerifier: string | undefined;
  let redirectUri: string | undefined;

  if (stateParam) {
    const oauthState = await stateStore.consumeOAuthState(stateParam);
    if (!oauthState) {
      return NextResponse.json({ error: "OAuth state expired or invalid" }, { status: 400 });
    }
    if (oauthState.provider !== provider) {
      return NextResponse.json({ error: "Provider mismatch" }, { status: 400 });
    }
    codeVerifier = oauthState.codeVerifier;
    redirectUri = oauthState.redirectUri;
  } else {
    // OpenRouter doesn't pass state back, find the most recent pending state for this provider
    const state = await stateStore.getState();
    const pending = state.oauthStates
      .filter((s) => s.provider === provider && new Date(s.expiresAt) > new Date())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

    if (!pending) {
      return NextResponse.json({ error: "No pending OAuth state found" }, { status: 400 });
    }

    codeVerifier = pending.codeVerifier;
    redirectUri = pending.redirectUri;
    // Consume it
    await stateStore.consumeOAuthState(pending.id);
  }

  try {
    if (isOpenRouterOAuth(provider)) {
      // OpenRouter returns a permanent API key
      const apiKey = await exchangeOpenRouterCode(code, codeVerifier!);
      await vault.setSecret(`llm.api.${provider}.key`, apiKey);

      await stateStore.addAction({
        actor: "user",
        kind: "auth",
        message: `OpenRouter API key obtained via OAuth`,
        context: { provider },
      });
    } else {
      // Standard OAuth token exchange (Google)
      const settings = await getProviderOAuthSettings(provider);
      const tokens = await exchangeOAuthCode({
        settings,
        code,
        redirectUri: redirectUri!,
        codeVerifier: codeVerifier!,
      });

      const config = await getProviderConfig(provider);
      const accessTokenKey =
        config?.oauthTokenSecret ?? `llm.oauth.${provider}.access_token`;

      await vault.setSecret(accessTokenKey, tokens.access_token);

      if (tokens.refresh_token) {
        await vault.setSecret(`llm.oauth.${provider}.refresh_token`, tokens.refresh_token);
      }

      await stateStore.addAction({
        actor: "user",
        kind: "auth",
        message: `OAuth token obtained for ${provider}`,
        context: {
          provider,
          scope: tokens.scope,
          tokenType: tokens.token_type,
        },
      });
    }

    // Persist provider config so resolveCredential can find the token
    const meta = getProviderMeta(provider);
    const existingConfig = await getProviderConfig(provider);
    const preferredModel = normalizeProviderModel(
      provider,
      existingConfig?.model ?? meta?.defaultModel ?? "",
    );
    const providerModels = await listProviderModelsFromApi(provider, { forceRefresh: true });
    const persistedModel = preferredModel && providerModels.includes(preferredModel)
      ? preferredModel
      : providerModels[0];
    if (!persistedModel) {
      throw new Error(`${provider} model list from provider API was empty.`);
    }

    await stateStore.setProviderConfig({
      provider,
      enabled: true,
      model: persistedModel,
      ...(existingConfig?.baseUrl && { baseUrl: existingConfig.baseUrl }),
      oauthTokenSecret: isOpenRouterOAuth(provider)
        ? undefined
        : (existingConfig?.oauthTokenSecret ?? `llm.oauth.${provider}.access_token`),
    });

    return NextResponse.redirect(
      new URL(`/settings?oauth=success&provider=${provider}`, request.url),
    );
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/settings?oauth=error&provider=${provider}&reason=${encodeURIComponent(
          error instanceof Error ? error.message : String(error),
        )}`,
        request.url,
      ),
    );
  }
}
