import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { exchangeOAuthCode, getProviderOAuthSettings } from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { LLMProvider } from "@/lib/state/types";

export const runtime = "nodejs";

const querySchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
  error: z.string().optional(),
});

const providerSchema = z.enum(["openai", "anthropic", "google", "openrouter"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const params = await context.params;
  const providerResult = providerSchema.safeParse(params.provider);

  if (!providerResult.success) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const provider = providerResult.data as LLMProvider;

  const parsed = querySchema.safeParse({
    state: request.nextUrl.searchParams.get("state"),
    code: request.nextUrl.searchParams.get("code"),
    error: request.nextUrl.searchParams.get("error") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.error) {
    return NextResponse.redirect(
      new URL(`/?oauth=error&provider=${provider}&reason=${encodeURIComponent(parsed.data.error)}`, request.url),
    );
  }

  const oauthState = await stateStore.consumeOAuthState(parsed.data.state);
  if (!oauthState) {
    return NextResponse.json({ error: "OAuth state expired or invalid" }, { status: 400 });
  }

  if (oauthState.provider !== provider) {
    return NextResponse.json({ error: "Provider mismatch" }, { status: 400 });
  }

  try {
    const settings = await getProviderOAuthSettings(provider);

    const tokens = await exchangeOAuthCode({
      settings,
      code: parsed.data.code,
      redirectUri: oauthState.redirectUri,
      codeVerifier: oauthState.codeVerifier,
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
      message: `OAuth token onboarded for ${provider}`,
      context: {
        provider,
        scope: tokens.scope,
        tokenType: tokens.token_type,
      },
    });

    return NextResponse.redirect(new URL(`/?oauth=success&provider=${provider}`, request.url));
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/?oauth=error&provider=${provider}&reason=${encodeURIComponent(
          error instanceof Error ? error.message : String(error),
        )}`,
        request.url,
      ),
    );
  }
}
