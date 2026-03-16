export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { approveAction, denyAction, expireStale } from "@/lib/approvals/queue";
import { isPlaybookApprovalExpired } from "@/lib/playbooks/approval-utils";
import { stateStore } from "@/lib/state/store";

const ActionSchema = z.object({
  action: z.enum(["approve", "deny"]),
  reason: z.string().optional().default(""),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const run = stateStore.getPlaybookRunById(id);
  if (!run) {
    return NextResponse.json({ error: "Approval not found" }, { status: 404 });
  }

  if (run.status !== "pending_approval") {
    return NextResponse.json({ error: "Approval already processed" }, { status: 409 });
  }

  if (isPlaybookApprovalExpired(run)) {
    expireStale();
    return NextResponse.json({ error: "Approval expired" }, { status: 410 });
  }

  if (parsed.data.action === "approve") {
    const result = approveAction(id);
    if (!result) {
      return NextResponse.json({ error: "Approval not found or already processed" }, { status: 404 });
    }
    return NextResponse.json(result);
  }

  const result = denyAction(id, "user", parsed.data.reason);
  if (!result) {
    return NextResponse.json({ error: "Approval not found or already processed" }, { status: 404 });
  }
  return NextResponse.json(result);
}
