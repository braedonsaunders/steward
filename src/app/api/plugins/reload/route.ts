export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { pluginRegistry } from "@/lib/plugins/registry";

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await pluginRegistry.reload();
  return NextResponse.json({ ok: true, plugins: pluginRegistry.getPluginRecords() });
}
