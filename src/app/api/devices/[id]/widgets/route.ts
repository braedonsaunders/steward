import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import type { DeviceWidget } from "@/lib/state/types";

export const runtime = "nodejs";

const CapabilitySchema = z.enum(["context", "state", "device-control"]);

const createWidgetSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(2).max(80),
  description: z.string().max(240).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  html: z.string().min(1).max(24_000),
  css: z.string().max(24_000).optional(),
  js: z.string().min(1).max(48_000),
  capabilities: z.array(CapabilitySchema).min(1).max(3),
  sourcePrompt: z.string().max(8_000).optional(),
});

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

  return NextResponse.json({ widgets: stateStore.getDeviceWidgets(id) });
}

export async function POST(
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

  const payload = createWidgetSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const now = new Date().toISOString();
  const existing = stateStore.getDeviceWidgetBySlug(id, payload.data.slug);
  const widget: DeviceWidget = {
    id: existing?.id ?? `widget-${randomUUID()}`,
    deviceId: id,
    slug: payload.data.slug,
    name: payload.data.name,
    description: payload.data.description,
    status: payload.data.status ?? "active",
    html: payload.data.html,
    css: payload.data.css ?? "",
    js: payload.data.js,
    capabilities: payload.data.capabilities,
    sourcePrompt: payload.data.sourcePrompt,
    createdBy: "user",
    revision: existing?.revision ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const saved = stateStore.upsertDeviceWidget(widget);
  stateStore.upsertDeviceWidgetRuntimeState({
    widgetId: saved.id,
    deviceId: id,
    stateJson: {},
    updatedAt: now,
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Created widget ${saved.name} for ${device.name}`,
    context: {
      deviceId: device.id,
      widgetId: saved.id,
      widgetSlug: saved.slug,
    },
  });

  return NextResponse.json({ widget: saved }, { status: 201 });
}
