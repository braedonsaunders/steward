import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { localToolApprovalDecisionSchema } from "@/lib/local-tools/schema";
import { localToolRuntime } from "@/lib/local-tools/runtime";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = localToolApprovalDecisionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  await localToolRuntime.initialize();
  const result = parsed.data.decision === "approve"
    ? localToolRuntime.approveApproval(id)
    : localToolRuntime.denyApproval(id, "user", parsed.data.reason ?? "");

  if (!result) {
    return NextResponse.json({ error: "Approval not found or no longer pending" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, approval: result });
}
