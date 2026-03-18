import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  createAnthropicApiKey,
  exchangeAnthropicCode,
  type AnthropicOAuthMode,
} from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import {
  clearAnthropicOAuthTokens,
  persistAnthropicOAuthTokens,
} from "@/lib/llm/anthropic-oauth";
import {
  listProviderModelsFromApi,
  normalizeProviderModel,
} from "@/lib/llm/models";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
  mode: z.enum(["max", "console"]).default("max"),
});

async function clearStoredAnthropicApiKey(): Promise<void> {
  await vault.deleteSecret("llm.api.anthropic.key").catch(() => {});
}

/**
 * Anthropic OAuth code exchange.
 *
 * The code-paste flow returns "code#state" where state == PKCE verifier.
 * Steward mirrors opencode's split Anthropic auth modes:
 * - "max": Claude Pro/Max OAuth session
 * - "console": Console login followed by API-key creation
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
  const mode = payload.data.mode as AnthropicOAuthMode;

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
    const tokens = await exchangeAnthropicCode(authCode, verifier, verifier);
    let credentialMode: "api-key" | "oauth-session";
    let apiKey: string | undefined;

    if (mode === "console") {
      apiKey = await createAnthropicApiKey(tokens.access_token);
      await clearAnthropicOAuthTokens();
      await vault.setSecret("llm.api.anthropic.key", apiKey);
      credentialMode = "api-key";
    } else {
      await clearStoredAnthropicApiKey();
      await persistAnthropicOAuthTokens(tokens);
      credentialMode = "oauth-session";
    }

    const meta = getProviderMeta("anthropic");
    const existingConfig = await getProviderConfig("anthropic");
    const preferredModel = normalizeProviderModel(
      "anthropic",
      existingConfig?.model ?? meta?.defaultModel ?? "claude-sonnet-4-20250514",
    );
    const providerModels = await listProviderModelsFromApi("anthropic", {
      forceRefresh: true,
      ...(apiKey
        ? { tokenOverride: apiKey }
        : { oauthTokenOverride: tokens.access_token }),
    });
    const persistedModel = preferredModel && providerModels.includes(preferredModel)
      ? preferredModel
      : providerModels[0];
    if (!persistedModel) {
      throw new Error("Anthropic model list from provider API was empty.");
    }

    await stateStore.setProviderConfig({
      ...(existingConfig ?? {}),
      provider: "anthropic",
      enabled: true,
      model: persistedModel,
      oauthTokenSecret: apiKey ? undefined : "llm.oauth.anthropic.access_token",
      updatedAt: new Date().toISOString(),
    });

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: apiKey
        ? "Anthropic connected via Create an API Key"
        : "Anthropic connected via Claude Pro/Max OAuth",
      context: {
        provider: "anthropic",
        selectedModel: persistedModel,
        mode,
        credentialMode,
      },
    });

    return NextResponse.json({
      ok: true,
      model: persistedModel,
      credentialMode,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
