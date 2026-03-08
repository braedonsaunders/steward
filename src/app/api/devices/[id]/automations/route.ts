import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { getWidgetControl } from "@/lib/widgets/controls";
import {
  DeviceAutomationMutationSchema,
  computeAutomationNextRunAt,
} from "@/lib/widgets/automations";

export const runtime = "nodejs";

const CreateAutomationSchema = DeviceAutomationMutationSchema.extend({
  widgetId: z.string().min(1),
  controlId: z.string().min(1),
  createdBy: z.enum(["steward", "user"]).optional(),
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

  return NextResponse.json({ automations: stateStore.getDeviceAutomations(id) });
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

  const payload = CreateAutomationSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const widget = stateStore.getDeviceWidgetById(payload.data.widgetId);
  if (!widget || widget.deviceId !== id) {
    return NextResponse.json({ error: "Widget not found for this device" }, { status: 404 });
  }

  const control = getWidgetControl(widget, payload.data.controlId);
  if (!control) {
    return NextResponse.json({ error: "Control not found for this widget" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const automation = stateStore.upsertDeviceAutomation({
    id: `device-automation-${randomUUID()}`,
    deviceId: id,
    targetKind: "widget-control",
    widgetId: widget.id,
    controlId: control.id,
    targetJson: {
      widgetId: widget.id,
      controlId: control.id,
      widgetSlug: widget.slug,
      controlLabel: control.label,
    },
    name: payload.data.name.trim(),
    description: payload.data.description?.trim() || undefined,
    enabled: payload.data.enabled ?? true,
    scheduleKind: payload.data.scheduleKind,
    intervalMinutes: payload.data.scheduleKind === "interval" ? payload.data.intervalMinutes : undefined,
    hourLocal: payload.data.scheduleKind === "daily" ? payload.data.hourLocal : undefined,
    minuteLocal: payload.data.scheduleKind === "daily" ? payload.data.minuteLocal : undefined,
    inputJson: payload.data.inputJson,
    lastRunAt: undefined,
    nextRunAt: computeAutomationNextRunAt({
      createdAt: now,
      enabled: payload.data.enabled ?? true,
      scheduleKind: payload.data.scheduleKind,
      intervalMinutes: payload.data.intervalMinutes,
      hourLocal: payload.data.hourLocal,
      minuteLocal: payload.data.minuteLocal,
      lastRunAt: undefined,
    }, new Date(now)),
    lastRunStatus: undefined,
    lastRunSummary: undefined,
    createdBy: payload.data.createdBy ?? "user",
    createdAt: now,
    updatedAt: now,
  });

  await stateStore.addAction({
    actor: automation.createdBy === "user" ? "user" : "steward",
    kind: "config",
    message: `Created automation ${automation.name} for ${device.name}`,
    context: {
      deviceId: id,
      automationId: automation.id,
      widgetId: widget.id,
      controlId: control.id,
    },
  });

  return NextResponse.json({ automation }, { status: 201 });
}
