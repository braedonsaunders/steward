import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  webResearchApiKeySecretRef,
  WEB_RESEARCH_PROVIDER_ORDER,
} from "@/lib/assistant/web-research-config";
import { vault } from "@/lib/security/vault";
import type { WebResearchProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const schema = z.object({
  provider: z.enum(["brave_api", "serper", "serpapi"]),
  apiKey: z.string().trim().max(1024).nullable(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const unlocked = await vault.ensureUnlocked();
  if (!unlocked) {
    return NextResponse.json({ error: "Vault is not available" }, { status: 503 });
  }

  const keys = await vault.listSecretKeys();
  const hasApiKey = WEB_RESEARCH_PROVIDER_ORDER.reduce<Record<WebResearchProvider, boolean>>((acc, provider) => {
    if (provider === "brave_scrape") {
      acc[provider] = false;
      return acc;
    }
    if (provider === "duckduckgo_scrape") {
      acc[provider] = false;
      return acc;
    }
    acc[provider] = keys.includes(webResearchApiKeySecretRef(provider));
    return acc;
  }, {
    brave_scrape: false,
    duckduckgo_scrape: false,
    brave_api: false,
    serper: false,
    serpapi: false,
  });

  return NextResponse.json({ hasApiKey });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const unlocked = await vault.ensureUnlocked();
  if (!unlocked) {
    return NextResponse.json({ error: "Vault is not available" }, { status: 503 });
  }

  const { provider, apiKey } = payload.data;
  const secretRef = webResearchApiKeySecretRef(provider);

  if (apiKey && apiKey.length > 0) {
    await vault.setSecret(secretRef, apiKey);
  } else {
    await vault.deleteSecret(secretRef);
  }

  return NextResponse.json({ ok: true, provider, hasApiKey: Boolean(apiKey && apiKey.length > 0) });
}
