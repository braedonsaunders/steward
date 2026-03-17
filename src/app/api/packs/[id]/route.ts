export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { packRepository } from "@/lib/packs/repository";
import { buildPackDetail, updateManagedPack } from "@/lib/packs/service";
import { stateStore } from "@/lib/state/store";

const PackPatchSchema = z.object({
  enabled: z.boolean().optional(),
  trustMode: z.enum(["verified", "unsigned"]).optional(),
  manifest: z.unknown().optional(),
  signerId: z.string().min(1).nullable().optional(),
  signature: z.string().min(1).nullable().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const pack = packRepository.getById(id);
  if (!pack) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }

  return NextResponse.json(buildPackDetail(pack));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const pack = packRepository.getById(id);
  if (!pack) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = PackPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let updated;
  try {
    updated = updateManagedPack(pack, {
      enabled: parsed.data.enabled,
      trustMode: parsed.data.trustMode,
      manifest: parsed.data.manifest,
      signerId: parsed.data.signerId,
      signature: parsed.data.signature,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Invalid pack manifest",
    }, { status: 400 });
  }
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `Updated pack ${updated.name}`,
    context: {
      packId: updated.id,
      version: updated.version,
    },
  });

  return NextResponse.json(buildPackDetail(updated));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const pack = packRepository.getById(id);
  if (!pack) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }
  if (pack.builtin) {
    return NextResponse.json({ error: "Built-in packs cannot be removed" }, { status: 400 });
  }

  const updated = packRepository.uninstall(id);
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `Removed pack ${pack.name}`,
    context: {
      packId: id,
    },
  });

  return NextResponse.json(updated ? buildPackDetail(updated) : { ok: true });
}
