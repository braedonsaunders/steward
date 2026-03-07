import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum(["release", "sweep"]),
  leaseId: z.string().min(1).optional(),
});

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

  return NextResponse.json({
    session,
    leases: stateStore.getProtocolSessionLeases({ sessionId: id }),
    messages: protocolSessionManager.getMessages(id, 100),
  });
}

export async function POST(
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

  const parsed = actionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.action === "sweep") {
    await protocolSessionManager.sweep();
    return NextResponse.json({ ok: true, session: protocolSessionManager.getSession(id) });
  }

  const leaseId = parsed.data.leaseId ?? session.activeLeaseId;
  if (!leaseId) {
    return NextResponse.json({ error: "No active lease to release" }, { status: 400 });
  }
  const lease = protocolSessionManager.releaseLease(leaseId);
  if (!lease) {
    return NextResponse.json({ error: "Lease not found or already inactive" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, lease, session: protocolSessionManager.getSession(id) });
}
