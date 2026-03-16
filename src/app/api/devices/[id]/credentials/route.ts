import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  redactDeviceCredential,
  storeDeviceCredential,
  validateDeviceCredential,
} from "@/lib/adoption/credentials";
import { getDeviceAdoptionSnapshot } from "@/lib/adoption/orchestrator";
import { isSupportedCredentialProtocol, normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const createSchema = z.object({
  protocol: z.string().trim().min(1),
  secret: z.string(),
  adapterId: z.string().trim().min(1).optional(),
  accountLabel: z.string().trim().min(1).max(256).optional(),
  scopeJson: z.record(z.string(), z.unknown()).optional(),
  validateNow: z.boolean().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const credentials = stateStore.getDeviceCredentials(id).map(redactDeviceCredential);
  return NextResponse.json({ credentials });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = createSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const normalizedProtocol = normalizeCredentialProtocol(payload.data.protocol);
  if (!isSupportedCredentialProtocol(normalizedProtocol)) {
    return NextResponse.json({ error: `Unsupported credential protocol: ${payload.data.protocol}` }, { status: 400 });
  }

  try {
    let credential = await storeDeviceCredential({
      deviceId: id,
      protocol: normalizedProtocol,
      secret: payload.data.secret,
      adapterId: payload.data.adapterId,
      accountLabel: payload.data.accountLabel,
      scopeJson: payload.data.scopeJson,
    });

    if (payload.data.validateNow) {
      credential = await validateDeviceCredential(id, credential.id);
    }

    const snapshot = await getDeviceAdoptionSnapshot(id);
    return NextResponse.json({
      credential: redactDeviceCredential(credential),
      snapshot,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to store credential" },
      { status: 400 },
    );
  }
}
