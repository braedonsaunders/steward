import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  buildOAuthAuthorizeUrl,
  createPkcePair,
  getProviderOAuthSettings,
} from "@/lib/auth/oauth";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const querySchema = z.object({
  provider: z.enum(["openai", "anthropic", "google", "openrouter"]),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = querySchema.safeParse({
    provider: request.nextUrl.searchParams.get("provider"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const provider = parsed.data.provider as LLMProvider;

  try {
    const settings = await getProviderOAuthSettings(provider);
    const { verifier, challenge } = createPkcePair();

    const redirectUri = `${request.nextUrl.origin}/api/providers/oauth/callback/${provider}`;
    const state = await stateStore.createOAuthState({
      provider,
      redirectUri,
      codeVerifier: verifier,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const authorizeUrl = buildOAuthAuthorizeUrl(
      settings,
      redirectUri,
      state.id,
      challenge,
    );

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: `Started OAuth flow for ${provider}`,
      context: {
        provider,
        stateId: state.id,
      },
    });

    return NextResponse.redirect(authorizeUrl);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
