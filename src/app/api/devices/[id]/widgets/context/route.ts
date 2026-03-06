import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { buildDeviceWidgetContext } from "@/lib/widgets/context";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const context = await buildDeviceWidgetContext(id);
  if (!context) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  return NextResponse.json({ context });
}
