import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { startDeviceAdoption } from "@/lib/adoption/orchestrator";
import { graphStore } from "@/lib/state/graph";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const createDeviceSchema = z.object({
  name: z.string().min(1),
  ip: z.string().min(3),
  type: z
    .enum([
      "server",
      "workstation",
      "router",
      "firewall",
      "switch",
      "access-point",
      "camera",
      "nas",
      "printer",
      "iot",
      "container-host",
      "hypervisor",
      "unknown",
    ])
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

  const state = await stateStore.getState();
  const existing = state.devices.find((item) => item.ip === payload.data.ip);
  const now = new Date().toISOString();

  const device = {
    id: existing?.id ?? randomUUID(),
    name: payload.data.name,
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
