import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { vault } from "@/lib/security/vault";
import { platformName } from "@/lib/security/os-keystore";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Auto-initialize and unlock — fully transparent
  await vault.ensureUnlocked();

  return NextResponse.json({
    initialized: await vault.isInitialized(),
    unlocked: vault.isUnlocked(),
    keyCount: (await vault.listSecretKeys()).length,
    protection: platformName(),
  });
}
