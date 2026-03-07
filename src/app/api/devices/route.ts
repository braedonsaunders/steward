import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { startDeviceAdoption } from "@/lib/adoption/orchestrator";
import { getDeviceNameValidationError, normalizeDeviceName } from "@/lib/devices/naming";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";
import { DEVICE_TYPE_VALUES } from "@/lib/state/types";

export const runtime = "nodejs";

const createDeviceSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(3),
  type: z
    .enum(DEVICE_TYPE_VALUES)
    .optional(),
  autonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = await stateStore.getState();

  return NextResponse.json({
    devices: state.devices,
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = createDeviceSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const normalizedName = normalizeDeviceName(payload.data.name);
  const nameValidationError = getDeviceNameValidationError(normalizedName);
  if (nameValidationError) {
    return NextResponse.json(
      { error: `Invalid device name '${normalizedName}'. ${nameValidationError}` },
      { status: 400 },
    );
  }

  const state = await stateStore.getState();
  const existing = state.devices.find((item) => item.ip === payload.data.ip);
  const now = new Date().toISOString();

  const device = {
    id: existing?.id ?? randomUUID(),
    name: normalizedName,
    ip: payload.data.ip,
    type: payload.data.type ?? existing?.type ?? "unknown",
    autonomyTier: payload.data.autonomyTier ?? existing?.autonomyTier ?? 1,
    status: existing?.status ?? "unknown",
    tags: existing?.tags ?? [],
    protocols: existing?.protocols ?? [],
    services: existing?.services ?? [],
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastChangedAt: now,
    metadata: {
      ...(existing?.metadata ?? {}),
      source: "manual",
      identity: {
        ...(typeof existing?.metadata?.identity === "object" && existing.metadata.identity !== null
          ? (existing.metadata.identity as Record<string, unknown>)
          : {}),
        nameManuallySet: true,
        nameManuallySetAt: now,
        nameSetBy: "user",
      },
      ...(existing?.hostname ? { hostname: existing.hostname } : {}),
      adoption: {
        ...(typeof existing?.metadata?.adoption === "object" && existing.metadata.adoption !== null
          ? (existing.metadata.adoption as Record<string, unknown>)
          : {}),
        status: "adopted",
      },
    },
    mac: existing?.mac,
    hostname: existing?.hostname,
    vendor: existing?.vendor,
    os: existing?.os,
    role: existing?.role,
  };

  await stateStore.upsertDevice(device);
  await graphStore.attachDevice(device);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Device added/updated: ${device.name} (${device.ip})`,
    context: {
      deviceId: device.id,
    },
  });

  try {
    await startDeviceAdoption(device.id, { triggeredBy: "user" });
  } catch (error) {
    await stateStore.addAction({
      actor: "steward",
      kind: "diagnose",
      message: `Failed to start onboarding for ${device.name}`,
      context: {
        deviceId: device.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  return NextResponse.json({ device });
}
