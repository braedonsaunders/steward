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
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const accessSurfaces = stateStore.getAccessSurfaces(id);
  return NextResponse.json({
    accessSurfaces,
    bindings: accessSurfaces,
  });
}
