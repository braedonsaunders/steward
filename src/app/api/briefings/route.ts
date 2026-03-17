export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { enqueueBriefingCompilationJob } from "@/lib/autonomy/runtime";
import { autonomyStore } from "@/lib/autonomy/store";
import { stateStore } from "@/lib/state/store";

const BriefingRequestSchema = z.object({
  missionId: z.string().optional(),
  subagentId: z.string().optional(),
  bindingId: z.string().optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    briefings: autonomyStore.listBriefings().slice(0, 50),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = BriefingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  enqueueBriefingCompilationJob({
    missionId: parsed.data.missionId,
    subagentId: parsed.data.subagentId,
    bindingId: parsed.data.bindingId,
    reason: "manual",
  });

  await stateStore.addAction({
    actor: "user",
    kind: "gateway",
    message: "Queued briefing compilation",
    context: parsed.data,
  });

  return NextResponse.json({ queued: true }, { status: 202 });
}
