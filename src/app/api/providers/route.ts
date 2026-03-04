import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { listProviderConfigs } from "@/lib/llm/config";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { vault } from "@/lib/security/vault";
import { providerPriority } from "@/lib/state/defaults";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const providerSchema = z.object({
  provider: z.string().min(1),
  enabled: z.boolean().optional(),
  model: z.string().optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Vault auto-unlocks — listSecretKeys calls ensureUnlocked internally
  const configs = await listProviderConfigs();
  const secretKeys = await vault.listSecretKeys();

  return NextResponse.json({
    providers: configs.map((config) => ({
      ...config,
      hasApiKeyInVault: secretKeys.includes(`llm.api.${config.provider}.key`),
      hasOAuthTokenInVault: config.oauthTokenSecret
        ? secretKeys.includes(config.oauthTokenSecret)
        : false,
    })),
  });
}

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

  const payload = providerSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const data = payload.data;
  const provider = data.provider as LLMProvider;
  let activeProvider: LLMProvider | undefined;

  await stateStore.updateState((state) => {
    const existingIndex = state.providerConfigs.findIndex((c) => c.provider === provider);
    const existing = existingIndex >= 0 ? state.providerConfigs[existingIndex] : undefined;

    const nextConfig = {
      ...(existing ?? { provider, enabled: false, model: "" }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.model !== undefined && { model: data.model }),
      ...(data.baseUrl !== undefined && { baseUrl: data.baseUrl || undefined }),
    };

    if (existingIndex >= 0) {
      state.providerConfigs[existingIndex] = nextConfig;
    } else {
      state.providerConfigs.push(nextConfig);
    }

    const providerOrder = Array.from(
      new Set<LLMProvider>([
        provider,
        "openai",
        ...providerPriority,
        ...state.providerConfigs.map((c) => c.provider),
      ]),
    );

    if (nextConfig.enabled) {
      activeProvider = provider;
    } else {
      const currentlyEnabled = state.providerConfigs
        .filter((c) => c.enabled)
        .map((c) => c.provider);

      const candidates = currentlyEnabled.length > 0
        ? currentlyEnabled
        : state.providerConfigs.map((c) => c.provider);

      activeProvider =
        providerOrder.find((candidate) => candidates.includes(candidate)) ??
        candidates[0];
    }

    state.providerConfigs = state.providerConfigs.map((config) => ({
      ...config,
      enabled: config.provider === activeProvider,
    }));

    return state;
  });

  if (data.apiKey) {
    await vault.setSecret(`llm.api.${provider}.key`, data.apiKey);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Provider updated: ${provider}`,
    context: {
      provider,
      model: data.model,
      enabled: data.enabled,
      activeProvider,
      hasApiKeyUpdate: Boolean(data.apiKey),
    },
  });

  return NextResponse.json({ ok: true, activeProvider });
}
