export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { autonomyStore } from "@/lib/autonomy/store";
import { subagentRepository } from "@/lib/subagents/repository";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    subagents: subagentRepository.listWithMetrics().map((subagent) => ({
      ...subagent,
      missions: autonomyStore.listMissions({ subagentId: subagent.id }),
      memories: subagentRepository.listMemories(subagent.id, 5),
      standingOrders: subagentRepository.listStandingOrders(subagent.id),
    })),
  });
}
