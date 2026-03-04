import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { hasProviderCredential } from "@/lib/llm/providers";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, boolean> = {};

  for (const meta of PROVIDER_REGISTRY) {
    if (meta.supportsOAuth || meta.requiresApiKey !== false) {
      results[meta.id] = await hasProviderCredential(meta.id as LLMProvider);
    }
  }

  return NextResponse.json(results);
}
