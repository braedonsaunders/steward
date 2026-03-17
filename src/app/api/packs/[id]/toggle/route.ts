export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { autonomyStore } from "@/lib/autonomy/store";
import { stateStore } from "@/lib/state/store";

const ToggleSchema = z.object({
  enabled: z.boolean(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const pack = autonomyStore.getPackById(id);
  if (!pack) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = ToggleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = autonomyStore.setPackEnabled(id, parsed.data.enabled);
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `${parsed.data.enabled ? "Enabled" : "Disabled"} pack ${pack.name}`,
    context: {
      packId: pack.id,
    },
  });

  return NextResponse.json(updated ?? pack);
}
