import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { getProviderMeta } from "@/lib/llm/registry";
import { listProviderModelsFromApi } from "@/lib/llm/models";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provider = request.nextUrl.searchParams.get("provider") as LLMProvider | null;
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";

  if (!provider) {
    return NextResponse.json({ error: "Missing provider parameter" }, { status: 400 });
  }

  const meta = getProviderMeta(provider);
  if (!meta) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  try {
    const models = await listProviderModelsFromApi(provider, { forceRefresh: refresh });
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ models: [], error: message }, { status: 502 });
  }
}
