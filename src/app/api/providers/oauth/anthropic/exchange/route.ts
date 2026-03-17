import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { createAnthropicApiKey, exchangeAnthropicCode } from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import { persistAnthropicOAuthTokens } from "@/lib/llm/anthropic-oauth";
import { listProviderModelsFromApi, normalizeProviderModel } from "@/lib/llm/models";
import { getProviderMeta } from "@/lib/llm/registry";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
});

function isMissingAnthropicApiKeyScopeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Anthropic API key creation failed") &&
    message.includes("org:create_api_key")
  );
}

/**
 * Anthropic OAuth code exchange — matches oneshot's opencode-anthropic-auth
 * plugin exactly.
 *
 * The code-paste flow returns "code#state" where state == PKCE verifier.
 * We exchange for OAuth tokens and store them in the vault. The provider
 * system uses these tokens with a custom fetch interceptor (Bearer token +
 * anthropic-beta headers) — NOT by creating an API key.
 */
export async function POST(request: NextRequest) {
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

  const payload = bodySchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const rawCode = payload.data.code.trim();

  // Anthropic's code-paste flow returns "code#state" where state == PKCE verifier
  const hashIndex = rawCode.indexOf("#");
  if (hashIndex === -1) {
    return NextResponse.json(
      { error: "Invalid code format. Expected code#state from Anthropic." },
      { status: 400 },
    );
  }

  const authCode = rawCode.slice(0, hashIndex);
  const verifier = rawCode.slice(hashIndex + 1);

  if (!authCode || !verifier) {
    return NextResponse.json(
      { error: "Invalid code format. Both code and state must be present." },
      { status: 400 },
    );
  }

  try {
    // Exchange code for OAuth tokens (matches oneshot's exchange() function)
    const tokens = await exchangeAnthropicCode(authCode, verifier, verifier);

    // Persist the OAuth session so later runtime restarts can refresh it.
    await persistAnthropicOAuthTokens(tokens);

    let apiKeyWarning: string | undefined;
    try {
      // Prefer a durable API key when Anthropic grants the required scope.
      const apiKey = await createAnthropicApiKey(tokens.access_token);
      await vault.setSecret("llm.api.anthropic.key", apiKey);
    } catch (error) {
      if (!isMissingAnthropicApiKeyScopeError(error)) {
        throw error;
      }

      apiKeyWarning =
        "Anthropic OAuth connected without API-key minting because the granted token does not include org:create_api_key.";
    }

    // Persist provider config only with a model that is returned by
    // Anthropic's live provider API.
    const meta = getProviderMeta("anthropic");
    const existingConfig = await getProviderConfig("anthropic");
    const preferredModel = normalizeProviderModel(
      "anthropic",
      existingConfig?.model ?? meta?.defaultModel ?? "claude-sonnet-4-20250514",
    );
    const providerModels = await listProviderModelsFromApi("anthropic", { forceRefresh: true });
    const persistedModel = preferredModel && providerModels.includes(preferredModel)
      ? preferredModel
      : providerModels[0];
    if (!persistedModel) {
      throw new Error("Anthropic model list from provider API was empty.");
    }

    await stateStore.setProviderConfig({
      provider: "anthropic",
      enabled: true,
      model: persistedModel,
      oauthTokenSecret: "llm.oauth.anthropic.access_token",
    });

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: "Anthropic connected via OAuth (Claude Pro/Max flow)",
      context: {
        provider: "anthropic",
        apiKeyMinted: !apiKeyWarning,
        ...(apiKeyWarning ? { warning: apiKeyWarning } : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      ...(apiKeyWarning ? { warning: apiKeyWarning } : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
