export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const UpdateDashboardWidgetPageSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).optional(),
  itemOrder: z.array(z.string().min(1)).optional(),
}).refine(
  (value) => typeof value.name !== "undefined"
    || typeof value.sortOrder !== "undefined"
    || typeof value.itemOrder !== "undefined",
  {
    message: "At least one page field must be updated.",
    path: ["name"],
  },
);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ pageId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = UpdateDashboardWidgetPageSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { pageId } = await params;
  let page = stateStore.getDashboardWidgetPageById(pageId);
  if (!page) {
    return NextResponse.json({ error: "Dashboard widget page not found" }, { status: 404 });
  }

  if (typeof parsed.data.name !== "undefined" || typeof parsed.data.sortOrder !== "undefined") {
    page = stateStore.updateDashboardWidgetPage(pageId, {
      name: parsed.data.name,
      sortOrder: parsed.data.sortOrder,
    });
  }

  if (page && Array.isArray(parsed.data.itemOrder)) {
    page = stateStore.reorderDashboardWidgetPageItems(pageId, parsed.data.itemOrder);
  }

  if (!page) {
    return NextResponse.json({ error: "Dashboard widget page not found" }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated dashboard widget page ${page.name}`,
    context: {
      pageId: page.id,
      renamed: typeof parsed.data.name !== "undefined",
      reorderedItems: Array.isArray(parsed.data.itemOrder),
    },
  });

  return NextResponse.json({ page });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ pageId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { pageId } = await params;
  const existing = stateStore.getDashboardWidgetPageById(pageId);
  if (!existing) {
    return NextResponse.json({ error: "Dashboard widget page not found" }, { status: 404 });
  }

  const deleted = stateStore.deleteDashboardWidgetPage(pageId);
  if (!deleted) {
    return NextResponse.json({ error: "Dashboard widget page not found" }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Deleted dashboard widget page ${existing.name}`,
    context: { pageId: existing.id, pageSlug: existing.slug },
  });

  return NextResponse.json({ ok: true });
}
