export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const UpdateDashboardWidgetPageItemSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  columnStart: z.number().int().min(1).max(12).optional(),
  columnSpan: z.number().int().min(1).max(12).optional(),
  rowStart: z.number().int().min(1).max(200).optional(),
  rowSpan: z.number().int().min(1).max(8).optional(),
  sortOrder: z.number().int().min(0).optional(),
}).refine(
  (value) => typeof value.title !== "undefined"
    || typeof value.columnStart !== "undefined"
    || typeof value.columnSpan !== "undefined"
    || typeof value.rowStart !== "undefined"
    || typeof value.rowSpan !== "undefined"
    || typeof value.sortOrder !== "undefined",
  {
    message: "At least one item field must be updated.",
    path: ["title"],
  },
);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = UpdateDashboardWidgetPageItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { itemId } = await params;
  const pages = stateStore.getDashboardWidgetPages();
  const existingItem = pages.flatMap((page) => page.items).find((item) => item.id === itemId) ?? null;
  if (!existingItem) {
    return NextResponse.json({ error: "Dashboard widget item not found" }, { status: 404 });
  }

  const page = stateStore.updateDashboardWidgetPageItem(itemId, parsed.data);
  if (!page) {
    return NextResponse.json({ error: "Dashboard widget item not found" }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated dashboard widget tile ${existingItem.title ?? existingItem.widget.widgetName}`,
    context: {
      pageId: page.id,
      itemId,
      widgetId: existingItem.widgetId,
      moved: typeof parsed.data.columnStart !== "undefined" || typeof parsed.data.rowStart !== "undefined",
      resized: typeof parsed.data.columnSpan !== "undefined" || typeof parsed.data.rowSpan !== "undefined",
    },
  });

  return NextResponse.json({ page });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { itemId } = await params;
  const pages = stateStore.getDashboardWidgetPages();
  const existingItem = pages.flatMap((page) => page.items).find((item) => item.id === itemId) ?? null;
  if (!existingItem) {
    return NextResponse.json({ error: "Dashboard widget item not found" }, { status: 404 });
  }

  const deleted = stateStore.deleteDashboardWidgetPageItem(itemId);
  if (!deleted) {
    return NextResponse.json({ error: "Dashboard widget item not found" }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Removed widget ${existingItem.widget.widgetName} from dashboard page`,
    context: {
      pageId: deleted.pageId,
      itemId,
      widgetId: existingItem.widgetId,
      deviceId: existingItem.widget.deviceId,
    },
  });

  return NextResponse.json({ pageId: deleted.pageId, page: deleted.page });
}
