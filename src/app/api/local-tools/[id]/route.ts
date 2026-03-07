import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { localToolActionSchema, localToolManifestSchema } from "@/lib/local-tools/schema";
import { localToolRuntime } from "@/lib/local-tools/runtime";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await localToolRuntime.initialize();
  const tool = localToolRuntime.getTool(id);
  if (!tool) {
    return NextResponse.json({ error: "Local tool not found" }, { status: 404 });
  }

  return NextResponse.json({
    tool,
    approvals: localToolRuntime.listApprovals({ toolId: id }),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = localToolManifestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.id !== id) {
    return NextResponse.json({ error: "Manifest id must match route id" }, { status: 400 });
  }

  await localToolRuntime.initialize();
  const tool = localToolRuntime.registerManifest(parsed.data);
  return NextResponse.json({ ok: true, tool });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = localToolActionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await localToolRuntime.initialize();
  const tool = localToolRuntime.getTool(id);
  if (!tool) {
    return NextResponse.json({ error: "Local tool not found" }, { status: 404 });
  }

  if (parsed.data.action === "install") {
    const result = await localToolRuntime.installTool(id, "user");
    return NextResponse.json(result, { status: result.ok ? 200 : result.status === "blocked" ? 202 : 400 });
  }

  const result = await localToolRuntime.checkHealth(id);
  return NextResponse.json({ ok: result.ok, tool: result.tool, summary: result.summary });
}
