export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const UpdateWindowSchema = z.object({
  name: z.string().min(1).optional(),
  deviceIds: z.array(z.string()).optional(),
  cronStart: z.string().min(1).optional(),
  durationMinutes: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const windows = stateStore.getMaintenanceWindows();
  const existing = windows.find((w) => w.id === id);

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = UpdateWindowSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = { ...existing, ...parsed.data };
  stateStore.upsertMaintenanceWindow(updated);

  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  stateStore.deleteMaintenanceWindow(id);

  return NextResponse.json({ ok: true });
}
