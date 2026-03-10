import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  deleteDeviceCredential,
  redactDeviceCredential,
  updateDeviceCredential,
  validateDeviceCredential,
} from "@/lib/adoption/credentials";
import { isSupportedCredentialProtocol, normalizeCredentialProtocol } from "@/lib/protocols/catalog";

export const runtime = "nodejs";

const updateSchema = z.object({
  protocol: z.string().trim().min(1).optional(),
  accountLabel: z.string().trim().max(256).optional(),
  secret: z.string().optional(),
  scopeJson: z.record(z.string(), z.unknown()).optional(),
  validateNow: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; credentialId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, credentialId } = await params;
  const payload = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const normalizedProtocol = payload.data.protocol ? normalizeCredentialProtocol(payload.data.protocol) : undefined;
  if (normalizedProtocol && !isSupportedCredentialProtocol(normalizedProtocol)) {
    return NextResponse.json({ error: `Unsupported credential protocol: ${payload.data.protocol}` }, { status: 400 });
  }

  try {
    let credential = await updateDeviceCredential({
      deviceId: id,
      credentialId,
      protocol: normalizedProtocol,
      accountLabel: payload.data.accountLabel,
      secret: payload.data.secret,
      scopeJson: payload.data.scopeJson,
    });

    if (payload.data.validateNow) {
      credential = await validateDeviceCredential(id, credentialId);
    }

    return NextResponse.json({ credential: redactDeviceCredential(credential) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update credential" },
      { status: 400 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; credentialId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, credentialId } = await params;
  try {
    await deleteDeviceCredential(id, credentialId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete credential" },
      { status: 400 },
    );
  }
}
