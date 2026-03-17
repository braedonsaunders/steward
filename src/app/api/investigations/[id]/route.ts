export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { investigationRepository } from "@/lib/investigations/repository";
import { stateStore } from "@/lib/state/store";

const InvestigationPatchSchema = z.object({
  status: z.enum(["open", "monitoring", "resolved", "closed"]).optional(),
  summary: z.string().optional(),
  resolution: z.string().optional(),
  hypothesis: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const investigation = investigationRepository.getById(id);
  if (!investigation) {
    return NextResponse.json({ error: "Investigation not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...investigation,
    steps: investigationRepository.listSteps(id),
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
  const investigation = investigationRepository.getById(id);
  if (!investigation) {
    return NextResponse.json({ error: "Investigation not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = InvestigationPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = investigationRepository.upsert({
    ...investigation,
    status: parsed.data.status ?? investigation.status,
    summary: parsed.data.summary ?? investigation.summary,
    resolution: parsed.data.resolution ?? investigation.resolution,
    hypothesis: parsed.data.hypothesis ?? investigation.hypothesis,
    updatedAt: new Date().toISOString(),
  });

  await stateStore.addAction({
    actor: "user",
    kind: "investigation",
    message: `Updated investigation ${updated.title}`,
    context: {
      investigationId: updated.id,
    },
  });

  return NextResponse.json({
    ...updated,
    steps: investigationRepository.listSteps(updated.id),
  });
}
