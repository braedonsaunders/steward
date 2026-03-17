export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import type { MissionRecord } from "@/lib/autonomy/types";
import { missionRepository } from "@/lib/missions/repository";
import { syncMissionDeviceScopeLinks } from "@/lib/missions/service";
import { stateStore } from "@/lib/state/store";

const MissionCreateSchema = z.object({
  title: z.string().min(3),
  summary: z.string().optional().default(""),
  objective: z.string().optional().default(""),
  kind: z.enum([
    "availability-guardian",
    "certificate-guardian",
    "backup-guardian",
    "storage-guardian",
    "wan-guardian",
    "daily-briefing",
    "custom",
  ]).optional().default("custom"),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  subagentId: z.string().optional(),
  packId: z.string().optional(),
  cadenceMinutes: z.number().int().min(1).max(7 * 24 * 60).optional().default(60),
  autoRun: z.boolean().optional().default(true),
  autoApprove: z.boolean().optional().default(false),
  shadowMode: z.boolean().optional().default(false),
  targetJson: z.record(z.string(), z.unknown()).optional().default({}),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `mission-${randomUUID().slice(0, 8)}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const missions = missionRepository.list().map((mission) => missionRepository.getWithDetails(mission.id) ?? mission);
  return NextResponse.json({
    missions,
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = MissionCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const now = new Date().toISOString();
  const mission: MissionRecord = {
    id: randomUUID(),
    slug: slugify(parsed.data.title),
    title: parsed.data.title,
    summary: parsed.data.summary,
    kind: parsed.data.kind,
    status: "active",
    priority: parsed.data.priority,
    objective: parsed.data.objective,
    subagentId: parsed.data.subagentId,
    packId: parsed.data.packId,
    cadenceMinutes: parsed.data.cadenceMinutes,
    autoRun: parsed.data.autoRun,
    autoApprove: parsed.data.autoApprove,
    shadowMode: parsed.data.shadowMode,
    targetJson: parsed.data.targetJson as MissionRecord["targetJson"],
    stateJson: {},
    nextRunAt: now,
    createdBy: "user",
    createdAt: now,
    updatedAt: now,
  };

  missionRepository.upsert(mission);
  syncMissionDeviceScopeLinks(mission);
  await stateStore.addAction({
    actor: "user",
    kind: "mission",
    message: `Created mission ${mission.title}`,
    context: {
      missionId: mission.id,
      kind: mission.kind,
    },
  });

  return NextResponse.json(missionRepository.getWithDetails(mission.id) ?? mission, { status: 201 });
}
