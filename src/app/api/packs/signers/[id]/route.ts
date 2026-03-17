export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { packRepository } from "@/lib/packs/repository";
import { stateStore } from "@/lib/state/store";

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  publicKeyPem: z.string().min(32).optional(),
  trustScope: z.enum(["trusted", "community"]).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const signer = packRepository.getSignerById(id);
  if (!signer) {
    return NextResponse.json({ error: "Signer not found" }, { status: 404 });
  }
  return NextResponse.json({ signer });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const signer = packRepository.getSignerById(id);
  if (!signer) {
    return NextResponse.json({ error: "Signer not found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = packRepository.upsertSigner({
    ...signer,
    name: parsed.data.name ?? signer.name,
    publicKeyPem: parsed.data.publicKeyPem ?? signer.publicKeyPem,
    trustScope: parsed.data.trustScope ?? signer.trustScope,
    enabled: parsed.data.enabled ?? signer.enabled,
    updatedAt: new Date().toISOString(),
  });
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `Updated pack signer ${updated.name}`,
    context: {
      signerId: updated.id,
    },
  });
  return NextResponse.json({ signer: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const signer = packRepository.getSignerById(id);
  if (!signer) {
    return NextResponse.json({ error: "Signer not found" }, { status: 404 });
  }
  packRepository.deleteSigner(id);
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `Removed pack signer ${signer.name}`,
    context: {
      signerId: id,
    },
  });
  return NextResponse.json({ ok: true });
}
