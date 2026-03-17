export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { investigationRepository } from "@/lib/investigations/repository";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const statusFilter = request.nextUrl.searchParams.get("status");
  const status = statusFilter
    ? statusFilter.split(",").map((value) => value.trim()).filter(Boolean) as Array<"open" | "monitoring" | "resolved" | "closed">
    : undefined;

  return NextResponse.json({
    investigations: investigationRepository.list({
      status,
    }).map((investigation) => ({
      ...investigation,
      steps: investigationRepository.listSteps(investigation.id),
    })),
  });
}
