import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; widgetId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, widgetId } = await params;
  const widget = stateStore.getDeviceWidgetById(widgetId);
  if (!widget || widget.deviceId !== id) {
    return NextResponse.json({ error: "Widget not found" }, { status: 404 });
  }

  const searchParams = request.nextUrl.searchParams;
  const scope = searchParams.get("scope") === "device" ? "device" : "widget";
  const rawLimit = Number(searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 20;

  const runs = scope === "device"
    ? stateStore.getDeviceWidgetOperationRunsForDevice(id, limit)
    : stateStore.getDeviceWidgetOperationRuns(widgetId, limit);

  return NextResponse.json({ runs, scope });
}
