import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { remoteDesktopManager } from "@/lib/remote-desktop/manager";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const session = remoteDesktopManager.getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Remote desktop session not found" }, { status: 404 });
  }

  return NextResponse.json({
    session,
    leases: stateStore.getProtocolSessionLeases({ sessionId: id }),
  });
}
