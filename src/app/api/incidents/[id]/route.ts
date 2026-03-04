import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const state = await stateStore.getState();

  const incident = state.incidents.find((i) => i.id === id);

  if (!incident) {
    return NextResponse.json({ error: "Incident not found" }, { status: 404 });
  }

  // Enrich with affected device details
  const affectedDevices = state.devices
    .filter((d) => incident.deviceIds.includes(d.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      ip: d.ip,
      type: d.type,
      status: d.status,
    }));

  return NextResponse.json({
    incident: {
      ...incident,
      affectedDevices,
    },
  });
}
