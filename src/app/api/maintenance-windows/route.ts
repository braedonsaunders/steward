export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const CreateWindowSchema = z.object({
  name: z.string().min(1),
  deviceIds: z.array(z.string()).optional().default([]),
  cronStart: z.string().min(1),
  durationMinutes: z.number().int().min(1),
  enabled: z.boolean().optional().default(true),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const windows = stateStore.getMaintenanceWindows();
  return NextResponse.json(windows);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = CreateWindowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const window = {
    id: randomUUID(),
    ...parsed.data,
    createdAt: new Date().toISOString(),
  };

  stateStore.upsertMaintenanceWindow(window);

  await stateStore.addAction({
    actor: "user",
    kind: "policy",
    message: `Created maintenance window: ${window.name}`,
    context: { windowId: window.id },
  });

  return NextResponse.json(window, { status: 201 });
}
