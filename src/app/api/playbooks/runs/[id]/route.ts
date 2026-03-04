export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const run = stateStore.getPlaybookRunById(id);

  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Enrich with device info
  const state = await stateStore.getState();
  const device = state.devices.find((d) => d.id === run.deviceId);

  return NextResponse.json({
    ...run,
    device: device ? { id: device.id, name: device.name, ip: device.ip, type: device.type, status: device.status } : null,
  });
}
