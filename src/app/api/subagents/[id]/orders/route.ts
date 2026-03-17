export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { subagentRepository } from "@/lib/subagents/repository";

const orderSchema = z.object({
  title: z.string().min(3),
  objective: z.string().min(3).optional().default(""),
  instructions: z.array(z.string().min(1)).min(1),
  enabled: z.boolean().optional().default(true),
  scopeJson: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!subagentRepository.getById(id)) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
  return NextResponse.json({
    standingOrders: subagentRepository.listStandingOrders(id),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!subagentRepository.getById(id)) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
  const parsed = orderSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const now = new Date().toISOString();
  const order = subagentRepository.upsertStandingOrder({
    id: `standing-order:${randomUUID()}`,
    subagentId: id,
    title: parsed.data.title,
    objective: parsed.data.objective,
    instructions: parsed.data.instructions,
    enabled: parsed.data.enabled,
    scopeJson: parsed.data.scopeJson,
  });
  await stateStore.addAction({
    actor: "user",
    kind: "mission",
    message: `Created standing order ${order.title}`,
    context: {
      subagentId: id,
      standingOrderId: order.id,
      createdAt: now,
    },
  });
  return NextResponse.json({ order }, { status: 201 });
}
