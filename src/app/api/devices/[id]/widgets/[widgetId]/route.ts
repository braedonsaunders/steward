import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import type { DeviceWidget } from "@/lib/state/types";
import { DeviceWidgetControlListSchema } from "@/lib/widgets/controls";

export const runtime = "nodejs";

const CapabilitySchema = z.enum(["context", "state", "device-control"]);

const updateWidgetSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(240).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  html: z.string().min(1).max(24_000).optional(),
  css: z.string().max(24_000).optional(),
  js: z.string().min(1).max(48_000).optional(),
  capabilities: z.array(CapabilitySchema).min(1).max(3).optional(),
  controls: DeviceWidgetControlListSchema.optional(),
  sourcePrompt: z.string().max(8_000).nullable().optional(),
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

  return NextResponse.json({ widget });
}

export async function PATCH(
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

  const payload = updateWidgetSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const nextControls = (payload.data.controls as DeviceWidget["controls"] | undefined) ?? widget.controls;

  const updated = stateStore.upsertDeviceWidget({
    ...widget,
    slug: payload.data.slug ?? widget.slug,
    name: payload.data.name ?? widget.name,
    description: payload.data.description === undefined
      ? widget.description
      : payload.data.description ?? undefined,
    status: payload.data.status ?? widget.status,
    html: payload.data.html ?? widget.html,
    css: payload.data.css ?? widget.css,
    js: payload.data.js ?? widget.js,
    capabilities: payload.data.capabilities ?? widget.capabilities,
    controls: nextControls,
    sourcePrompt: payload.data.sourcePrompt === undefined
      ? widget.sourcePrompt
      : payload.data.sourcePrompt ?? undefined,
    updatedAt: new Date().toISOString(),
  });

  return NextResponse.json({ widget: updated });
}

export async function DELETE(
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

  const deleted = stateStore.deleteDeviceWidget(widgetId);
  return NextResponse.json({ ok: deleted });
}
