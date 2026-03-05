export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { adapterRegistry } from "@/lib/adapters/registry";

const CreateAdapterSchema = z.object({
  manifest: z.unknown(),
  entrySource: z.string().min(1),
  adapterSkillMd: z.string().optional(),
  toolSkillMd: z.record(z.string(), z.string()).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await adapterRegistry.initialize();
  return NextResponse.json(adapterRegistry.getAdapterRecords());
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = CreateAdapterSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const created = await adapterRegistry.createAdapterPackage(parsed.data);
    const pkg = adapterRegistry.getAdapterPackageById(created.id);
    return NextResponse.json({ ok: true, adapter: created, package: pkg }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create adapter" },
      { status: 400 },
    );
  }
}
