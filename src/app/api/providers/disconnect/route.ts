import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const schema = z.object({
  provider: z.string().min(1),
});

/**
 * POST /api/providers/disconnect
 *
 * Removes all credentials (API keys + OAuth tokens) for a provider from the
 * vault and disables the provider config. Used by the "Disconnect" button in
 * the Settings page.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const provider = payload.data.provider as LLMProvider;

  // Delete all known vault secrets for this provider
  const secretPrefixes = [
    `llm.api.${provider}.key`,
    `llm.oauth.${provider}.access_token`,
    `llm.oauth.${provider}.refresh_token`,
    `llm.oauth.${provider}.expires_at`,
    `llm.oauth.${provider}.account_id`,
    `llm.oauth.${provider}.client_id`,
    `llm.oauth.${provider}.client_secret`,
  ];

  let deletedCount = 0;
  for (const key of secretPrefixes) {
    try {
      const existing = await vault.getSecret(key);
      if (existing) {
        await vault.deleteSecret(key);
        deletedCount++;
      }
    } catch {
      // Secret doesn't exist or already deleted — ignore
    }
  }

  // Disable the provider config
  await stateStore.updateState((state) => {
    const idx = state.providerConfigs.findIndex((c) => c.provider === provider);
    if (idx >= 0) {
      state.providerConfigs[idx].enabled = false;
      // Clear OAuth-specific config fields
      delete state.providerConfigs[idx].oauthTokenSecret;
    }
    return state;
  });

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: `Disconnected provider ${provider} (removed ${deletedCount} credential${deletedCount !== 1 ? "s" : ""})`,
    context: { provider, deletedCount },
  });

  return NextResponse.json({ ok: true, deletedCount });
}
