export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const CreateDashboardWidgetPageItemSchema = z.object({
  widgetId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  columnStart: z.number().int().min(1).max(12).optional(),
  columnSpan: z.number().int().min(1).max(12).optional(),
  rowStart: z.number().int().min(1).max(200).optional(),
  rowSpan: z.number().int().min(1).max(8).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ pageId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = CreateDashboardWidgetPageItemSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { pageId } = await params;
  const page = stateStore.getDashboardWidgetPageById(pageId);
  if (!page) {
    return NextResponse.json({ error: "Dashboard widget page not found" }, { status: 404 });
  }

  const widget = stateStore.getDeviceWidgetById(parsed.data.widgetId);
  if (!widget) {
    return NextResponse.json({ error: "Device widget not found" }, { status: 404 });
  }

  const updatedPage = stateStore.addDashboardWidgetPageItem({
    id: `dashboard-widget-item-${randomUUID()}`,
    pageId,
    widgetId: parsed.data.widgetId,
    title: parsed.data.title,
    columnStart: parsed.data.columnStart,
    columnSpan: parsed.data.columnSpan,
    rowStart: parsed.data.rowStart,
    rowSpan: parsed.data.rowSpan,
    createdAt: new Date().toISOString(),
  });

  if (!updatedPage) {
    return NextResponse.json({ error: "Failed to add widget to dashboard page" }, { status: 400 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Added widget ${widget.name} to dashboard page ${updatedPage.name}`,
    context: {
      pageId: updatedPage.id,
      widgetId: widget.id,
      deviceId: widget.deviceId,
    },
  });

  return NextResponse.json({ page: updatedPage }, { status: 201 });
}
