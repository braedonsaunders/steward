export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const CreateDashboardWidgetPageSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    pages: stateStore.getDashboardWidgetPages(),
    inventory: stateStore.getDashboardWidgetInventory(),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = CreateDashboardWidgetPageSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const page = stateStore.createDashboardWidgetPage({
    id: `dashboard-widget-page-${randomUUID()}`,
    name: parsed.data.name,
    createdAt: new Date().toISOString(),
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Created dashboard widget page ${page.name}`,
    context: { pageId: page.id, pageSlug: page.slug },
  });

  return NextResponse.json({ page }, { status: 201 });
}
