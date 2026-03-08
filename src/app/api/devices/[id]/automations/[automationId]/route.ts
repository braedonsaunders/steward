import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { getWidgetControl } from "@/lib/widgets/controls";
import {
  automationTargetControlId,
  automationTargetWidgetId,
  DeviceAutomationMutationSchema,
  computeAutomationNextRunAt,
} from "@/lib/widgets/automations";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; automationId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, automationId } = await params;
  const automation = stateStore.getDeviceAutomationById(automationId);
  if (!automation || automation.deviceId !== id) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }

  return NextResponse.json({ automation });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; automationId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, automationId } = await params;
  const automation = stateStore.getDeviceAutomationById(automationId);
  if (!automation || automation.deviceId !== id) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }

  const payload = DeviceAutomationMutationSchema.partial().safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const widget = stateStore.getDeviceWidgetById(automationTargetWidgetId(automation));
  if (!widget || widget.deviceId !== id) {
    return NextResponse.json({ error: "Automation widget target no longer exists" }, { status: 409 });
  }

  const control = getWidgetControl(widget, automationTargetControlId(automation));
  if (!control) {
    return NextResponse.json({ error: "Automation control target no longer exists" }, { status: 409 });
  }

  const next = {
    ...automation,
    name: typeof payload.data.name === "string" ? payload.data.name.trim() || automation.name : automation.name,
    description: typeof payload.data.description === "string"
      ? payload.data.description.trim() || undefined
      : payload.data.description === undefined
        ? automation.description
        : undefined,
    enabled: payload.data.enabled ?? automation.enabled,
    scheduleKind: payload.data.scheduleKind ?? automation.scheduleKind,
    intervalMinutes: payload.data.scheduleKind === "interval"
      ? payload.data.intervalMinutes
      : typeof payload.data.scheduleKind === "undefined"
        ? automation.intervalMinutes
        : undefined,
    hourLocal: payload.data.scheduleKind === "daily"
      ? payload.data.hourLocal
      : typeof payload.data.scheduleKind === "undefined"
        ? automation.hourLocal
        : undefined,
    minuteLocal: payload.data.scheduleKind === "daily"
      ? payload.data.minuteLocal
      : typeof payload.data.scheduleKind === "undefined"
        ? automation.minuteLocal
        : undefined,
    inputJson: payload.data.inputJson ?? automation.inputJson,
    targetJson: {
      ...automation.targetJson,
      widgetId: widget.id,
      controlId: control.id,
      widgetSlug: widget.slug,
      controlLabel: control.label,
    },
    updatedAt: new Date().toISOString(),
  };

  const updated = stateStore.upsertDeviceAutomation({
    ...next,
    nextRunAt: computeAutomationNextRunAt(next, new Date(next.updatedAt)),
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated automation ${updated.name} for ${widget.name}`,
    context: {
      deviceId: id,
      automationId: updated.id,
      widgetId: widget.id,
      controlId: control.id,
    },
  });

  return NextResponse.json({ automation: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; automationId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, automationId } = await params;
  const automation = stateStore.getDeviceAutomationById(automationId);
  if (!automation || automation.deviceId !== id) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }

  const deleted = stateStore.deleteDeviceAutomation(automationId);
  return NextResponse.json({ ok: deleted });
}
