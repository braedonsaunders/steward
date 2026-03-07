import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const session = protocolSessionManager.getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Protocol session not found" }, { status: 404 });
  }

  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(2_000, Math.floor(limitRaw))) : 100;
  return NextResponse.json({ messages: protocolSessionManager.getMessages(id, limit) });
}
