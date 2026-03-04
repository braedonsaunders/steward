export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pending = stateStore.getPendingApprovals();

  // Enrich with device names
  const state = await stateStore.getState();
  const deviceMap = new Map(state.devices.map((d) => [d.id, d]));

  const enriched = pending.map((run) => {
    const device = deviceMap.get(run.deviceId);
    return {
      ...run,
      deviceName: device?.name ?? run.deviceId,
      deviceIp: device?.ip ?? "unknown",
    };
  });

  return NextResponse.json(enriched);
}
