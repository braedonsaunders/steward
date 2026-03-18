import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  createPkcePair,
  buildAnthropicAuthorizeUrl,
  type AnthropicOAuthMode,
} from "@/lib/auth/oauth";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";

export const runtime = "nodejs";

const bodySchema = z.object({
  mode: z.enum(["max", "console"]).default("max"),
});

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

  try {
    let mode: AnthropicOAuthMode = "max";
    const rawBody = await request.text();
    if (rawBody.trim().length > 0) {
      const payload = bodySchema.safeParse(JSON.parse(rawBody));
      if (!payload.success) {
        return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
      }
      mode = payload.data.mode;
    }

    const { verifier, challenge } = createPkcePair();
    const url = buildAnthropicAuthorizeUrl(challenge, verifier, mode);

    // The verifier is embedded in the auth URL as the state parameter.
    // When the user pastes the code (format: code#state), the state IS the
    // verifier, so the exchange route can extract it from the pasted code
    // without needing server-side storage.
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
