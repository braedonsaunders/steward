export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { autonomyStore } from "@/lib/autonomy/store";
import { missionRepository } from "@/lib/missions/repository";
import { stateStore } from "@/lib/state/store";
import { subagentRepository } from "@/lib/subagents/repository";

const SubagentPatchSchema = z.object({
  status: z.enum(["active", "paused", "disabled"]).optional(),
  channelBindingId: z.string().nullable().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const subagent = subagentRepository.getById(id);
  if (!subagent) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...subagent,
    missions: autonomyStore.listMissions({ subagentId: id }),
    investigations: autonomyStore.listInvestigations({
      subagentId: id,
      status: ["open", "monitoring"],
    }),
    memories: subagentRepository.listMemories(id, 50),
    standingOrders: subagentRepository.listStandingOrders(id),
    incomingDelegations: missionRepository.listDelegationsForSubagent(id),
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
  const subagent = subagentRepository.getById(id);
  if (!subagent) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = SubagentPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = subagentRepository.upsert({
    ...subagent,
    status: parsed.data.status ?? subagent.status,
    channelBindingId: parsed.data.channelBindingId === undefined
      ? subagent.channelBindingId
      : parsed.data.channelBindingId ?? undefined,
    updatedAt: new Date().toISOString(),
  });

  await stateStore.addAction({
    actor: "user",
    kind: "mission",
    message: `Updated subagent ${updated.name}`,
    context: {
      subagentId: updated.id,
    },
  });

  return NextResponse.json(updated);
}
