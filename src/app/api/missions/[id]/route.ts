export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { autonomyStore } from "@/lib/autonomy/store";
import { missionRepository } from "@/lib/missions/repository";
import { syncMissionDeviceScopeLinks } from "@/lib/missions/service";
import { stateStore } from "@/lib/state/store";

const MissionPatchSchema = z.object({
  title: z.string().min(3).optional(),
  summary: z.string().optional(),
  objective: z.string().optional(),
  status: z.enum(["active", "paused", "completed", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  subagentId: z.string().nullable().optional(),
  cadenceMinutes: z.number().int().min(1).max(7 * 24 * 60).optional(),
  autoRun: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  shadowMode: z.boolean().optional(),
  targetJson: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const mission = missionRepository.getWithDetails(id);
  if (!mission) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...mission,
    runs: autonomyStore.listMissionRuns(id, 20),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const mission = missionRepository.getById(id);
  if (!mission) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = MissionPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = missionRepository.upsert({
    ...mission,
    title: parsed.data.title ?? mission.title,
    summary: parsed.data.summary ?? mission.summary,
    objective: parsed.data.objective ?? mission.objective,
    status: parsed.data.status ?? mission.status,
    priority: parsed.data.priority ?? mission.priority,
    subagentId: parsed.data.subagentId === undefined ? mission.subagentId : parsed.data.subagentId ?? undefined,
    cadenceMinutes: parsed.data.cadenceMinutes ?? mission.cadenceMinutes,
    autoRun: parsed.data.autoRun ?? mission.autoRun,
    autoApprove: parsed.data.autoApprove ?? mission.autoApprove,
    shadowMode: parsed.data.shadowMode ?? mission.shadowMode,
    targetJson: parsed.data.targetJson ? parsed.data.targetJson as typeof mission.targetJson : mission.targetJson,
    updatedAt: new Date().toISOString(),
  });
  syncMissionDeviceScopeLinks(updated);

  await stateStore.addAction({
    actor: "user",
    kind: "mission",
    message: `Updated mission ${updated.title}`,
    context: {
      missionId: updated.id,
    },
  });

  return NextResponse.json(missionRepository.getWithDetails(id) ?? updated);
}
