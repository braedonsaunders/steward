import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { localToolRuntime } from "@/lib/local-tools/runtime";
import type { LocalToolApproval } from "@/lib/state/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await localToolRuntime.initialize();
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const toolId = request.nextUrl.searchParams.get("toolId") ?? undefined;
  const approvals = localToolRuntime.listApprovals({
    ...(toolId ? { toolId } : {}),
    ...(status ? { status: status as LocalToolApproval["status"] } : {}),
  });

  return NextResponse.json({ approvals });
}
