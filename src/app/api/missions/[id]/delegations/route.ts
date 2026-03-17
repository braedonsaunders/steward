export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { missionRepository } from "@/lib/missions/repository";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!missionRepository.getById(id)) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }
  return NextResponse.json({
    delegations: missionRepository.listDelegations(id),
  });
}
