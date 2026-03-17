export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { enqueueMissionJob } from "@/lib/autonomy/runtime";
import { autonomyStore } from "@/lib/autonomy/store";
import { stateStore } from "@/lib/state/store";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const mission = autonomyStore.getMissionById(id);
  if (!mission) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }

  enqueueMissionJob(id);
  await stateStore.addAction({
    actor: "user",
    kind: "mission",
    message: `Queued mission run for ${mission.title}`,
    context: {
      missionId: mission.id,
    },
  });

  return NextResponse.json({ queued: true, missionId: id }, { status: 202 });
}
