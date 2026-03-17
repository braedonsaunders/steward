export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { packRepository } from "@/lib/packs/repository";
import { stateStore } from "@/lib/state/store";

const signerSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(120),
  publicKeyPem: z.string().min(32),
  trustScope: z.enum(["trusted", "community"]).optional().default("trusted"),
  enabled: z.boolean().optional().default(true),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    signers: packRepository.listSigners(),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = signerSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (packRepository.getSignerBySlug(parsed.data.slug)) {
    return NextResponse.json({ error: "Signer slug already exists" }, { status: 409 });
  }

  const now = new Date().toISOString();
  const signer = packRepository.upsertSigner({
    id: `pack-signer:${randomUUID()}`,
    slug: parsed.data.slug,
    name: parsed.data.name,
    publicKeyPem: parsed.data.publicKeyPem,
    algorithm: "ed25519",
    trustScope: parsed.data.trustScope,
    enabled: parsed.data.enabled,
    createdAt: now,
    updatedAt: now,
  });
  await stateStore.addAction({
    actor: "user",
    kind: "pack",
    message: `Registered pack signer ${signer.name}`,
    context: {
      signerId: signer.id,
      slug: signer.slug,
    },
  });
  return NextResponse.json({ signer }, { status: 201 });
}
