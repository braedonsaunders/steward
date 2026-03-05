export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { adapterRegistry } from "@/lib/adapters/registry";

const ConfigSchema = z.object({
  mode: z.enum(["merge", "replace"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  toolMode: z.enum(["merge", "replace"]).optional(),
  toolConfig: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (value) => value.config !== undefined || value.toolConfig !== undefined,
  { message: "Provide config and/or toolConfig" },
);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await adapterRegistry.initialize();
  const record = adapterRegistry.getAdapterRecordById(id);
  if (!record) {
    return NextResponse.json({ error: "Adapter not found" }, { status: 404 });
  }

  return NextResponse.json(record);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const parsed = ConfigSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await adapterRegistry.initialize();
    const updated = await adapterRegistry.updateAdapterConfig(id, {
      config: parsed.data.config,
      mode: parsed.data.mode ?? "merge",
      toolConfig: parsed.data.toolConfig,
      toolMode: parsed.data.toolMode ?? "merge",
    });
    return NextResponse.json({ ok: true, adapter: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update adapter config" },
      { status: 400 },
    );
  }
}
