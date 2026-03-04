import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { createPkcePair, buildAnthropicAuthorizeUrl } from "@/lib/auth/oauth";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";

export const runtime = "nodejs";

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
    const { verifier, challenge } = createPkcePair();
    const url = buildAnthropicAuthorizeUrl(challenge, verifier);

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
