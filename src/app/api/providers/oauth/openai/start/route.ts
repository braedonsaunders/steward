import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { startOpenAIOAuthFlow } from "@/lib/auth/openai-oauth-server";

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
    const authorizeUrl = await startOpenAIOAuthFlow();
    return NextResponse.json({ url: authorizeUrl });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
