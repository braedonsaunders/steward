import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import {
  WidgetOperationSchema,
  executeWidgetOperation,
} from "@/lib/widgets/operations";

export const runtime = "nodejs";

const WidgetOperationRequestSchema = z.union([
  WidgetOperationSchema.transform((operation) => ({ operation, approved: false })),
  z.object({
    operation: WidgetOperationSchema,
    approved: z.boolean().optional(),
  }),
]);

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

  if (!widget.capabilities.includes("device-control")) {
    return NextResponse.json({ error: "Widget is not allowed to execute device operations" }, { status: 403 });
  }

  const payload = WidgetOperationRequestSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const result = await executeWidgetOperation({
    device,
    widget,
    input: payload.data.operation,
    approved: payload.data.approved === true,
  });

  const statusCode = result.ok
    ? 200
    : result.status === "requires-approval"
      ? 428
      : result.status === "blocked"
        ? 403
        : 409;

  return NextResponse.json(result, { status: statusCode });
}
