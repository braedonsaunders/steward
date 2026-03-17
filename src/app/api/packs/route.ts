export const runtime = "nodejs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { validatePackManifest } from "@/lib/autonomy/pack-validation";
import { buildPackDetail, createManagedPack } from "@/lib/packs/service";
import { packRepository } from "@/lib/packs/repository";
import { stateStore } from "@/lib/state/store";

const PackCreateSchema = z.object({
  enabled: z.boolean().optional().default(true),
  trustMode: z.enum(["verified", "unsigned"]).optional().default("unsigned"),
  manifest: z.unknown(),
  signerId: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    packs: packRepository.listSummaries(),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = PackCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  let manifest;
  try {
    manifest = validatePackManifest(parsed.data.manifest);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Invalid pack manifest",
    }, { status: 400 });
  }
  const existing = packRepository.list().find((candidate) => candidate.slug === manifest.slug);
  if (existing) {
    return NextResponse.json({ error: `Pack slug ${manifest.slug} already exists` }, { status: 409 });
  }

  let pack;
  try {
    pack = createManagedPack({
      enabled: parsed.data.enabled,
      trustMode: parsed.data.trustMode,
      manifest,
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
    message: `Installed managed pack ${pack.name}`,
    context: {
      packId: pack.id,
      slug: pack.slug,
      version: pack.version,
    },
  });

  return NextResponse.json(buildPackDetail(pack), { status: 201 });
}
