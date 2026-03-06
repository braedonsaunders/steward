import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const updateStateSchema = z.object({
  state: z.record(z.string(), z.unknown()),
});

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

  const state = stateStore.getDeviceWidgetRuntimeState(widgetId) ?? {
    widgetId,
    deviceId: id,
    stateJson: {},
    updatedAt: widget.updatedAt,
  };
  return NextResponse.json({ state });
}

export async function PUT(
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

  const payload = updateStateSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const state = stateStore.upsertDeviceWidgetRuntimeState({
    widgetId,
    deviceId: id,
    stateJson: payload.data.state,
    updatedAt: new Date().toISOString(),
  });

  return NextResponse.json({ state });
}
