export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { adapterRegistry } from "@/lib/adapters/registry";

const PackageMutationSchema = z.object({
  manifest: z.unknown(),
  entrySource: z.string().min(1),
  adapterSkillMd: z.string().optional(),
  toolSkillMd: z.record(z.string(), z.string()).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  await adapterRegistry.initialize();

  try {
    const pkg = adapterRegistry.getAdapterPackageById(id);
    if (!pkg) {
      return NextResponse.json({ error: "Adapter not found" }, { status: 404 });
    }
    return NextResponse.json(pkg);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load adapter package" },
      { status: 400 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const parsed = PackageMutationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const updated = await adapterRegistry.updateAdapterPackage(id, parsed.data);
    const pkg = adapterRegistry.getAdapterPackageById(updated.id);
    return NextResponse.json({ ok: true, adapter: updated, package: pkg });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update adapter package" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await adapterRegistry.deleteAdapterPackage(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete adapter" },
      { status: 400 },
    );
  }
}

