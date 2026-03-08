import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { executeWidgetControl, getWidgetControl } from "@/lib/widgets/controls";

export const runtime = "nodejs";

const ExecuteControlSchema = z.object({
  controlId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  approved: z.boolean().optional(),
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

  return NextResponse.json({ controls: widget.controls });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; widgetId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, widgetId } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const widget = stateStore.getDeviceWidgetById(widgetId);
  if (!widget || widget.deviceId !== id) {
    return NextResponse.json({ error: "Widget not found" }, { status: 404 });
  }

  const payload = ExecuteControlSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const control = getWidgetControl(widget, payload.data.controlId);
  if (!control) {
    return NextResponse.json({ error: "Control not found" }, { status: 404 });
  }

  if (control.execution.kind === "operation" && !widget.capabilities.includes("device-control")) {
    return NextResponse.json({ error: "Widget is not allowed to execute device controls" }, { status: 403 });
  }

  try {
    const result = await executeWidgetControl({
      device,
      widget,
      control,
      inputValues: payload.data.input,
      approved: payload.data.approved === true,
      actor: "user",
    });
    const statusCode = result.ok
      ? 200
      : result.status === "requires-approval"
        ? 428
        : result.status === "blocked"
          ? 403
          : 409;
    return NextResponse.json(result, { status: statusCode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Widget control failed" },
      { status: 400 },
    );
  }
}
