export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { adapterRegistry } from "@/lib/adapters/registry";

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await adapterRegistry.reload();
  return NextResponse.json({ ok: true, adapters: adapterRegistry.getAdapterRecords() });
}
