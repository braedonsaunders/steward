import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { exchangeAnthropicCode, createAnthropicApiKey } from "@/lib/auth/oauth";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const bodySchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
});

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vaultGate = await ensureVaultReadyForProviders();
  if (!vaultGate.ok) {
    return NextResponse.json(
      { error: vaultGate.error, code: vaultGate.code },
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
    // 1. Exchange code for tokens
    const tokens = await exchangeAnthropicCode(authCode, verifier, verifier);

    // 2. Create a permanent API key using the access token
    const apiKey = await createAnthropicApiKey(tokens.access_token);

    // 3. Store the API key in vault (same slot as manual API keys)
    await vault.setSecret("llm.api.anthropic.key", apiKey);

    // 4. Also store refresh token for potential future use
    if (tokens.refresh_token) {
      await vault.setSecret("llm.oauth.anthropic.refresh_token", tokens.refresh_token);
    }

    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: "Anthropic API key created via OAuth (Claude CLI flow)",
      context: { provider: "anthropic" },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
