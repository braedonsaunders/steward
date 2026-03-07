import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { localToolRuntime } from "@/lib/local-tools/runtime";
import { localToolManifestSchema } from "@/lib/local-tools/schema";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await localToolRuntime.initialize();
  return NextResponse.json({ tools: localToolRuntime.listTools() });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = localToolManifestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await localToolRuntime.initialize();
  const tool = localToolRuntime.registerManifest(parsed.data);
  await localToolRuntime.initialize();

  return NextResponse.json({ ok: true, tool });
}
