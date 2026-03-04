import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { listProviderConfigs } from "@/lib/llm/config";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const providerSchema = z.object({
  provider: z.enum(["openai", "anthropic", "google", "openrouter"]),
  enabled: z.boolean().optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  oauthAuthUrl: z.string().url().optional(),
  oauthTokenUrl: z.string().url().optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const payload = providerSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const data = payload.data;

  await stateStore.updateState(async (state) => {
    const idx = state.providerConfigs.findIndex((item) => item.provider === data.provider);
    if (idx === -1) {
      return state;
    }

    state.providerConfigs[idx] = {
      ...state.providerConfigs[idx],
      enabled: data.enabled ?? state.providerConfigs[idx].enabled,
      model: data.model ?? state.providerConfigs[idx].model,
      baseUrl: data.baseUrl ?? state.providerConfigs[idx].baseUrl,
      oauthAuthUrl: data.oauthAuthUrl ?? state.providerConfigs[idx].oauthAuthUrl,
      oauthTokenUrl: data.oauthTokenUrl ?? state.providerConfigs[idx].oauthTokenUrl,
    };

    return state;
  });

  if (data.apiKey) {
    await vault.setSecret(`llm.api.${data.provider}.key`, data.apiKey);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Provider updated: ${data.provider}`,
    context: {
      provider: data.provider,
      model: data.model,
      enabled: data.enabled,
      hasApiKeyUpdate: Boolean(data.apiKey),
    },
  });

  return NextResponse.json({ ok: true });
}
