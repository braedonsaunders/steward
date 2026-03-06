import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { getAdoptionRecord } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { Workload } from "@/lib/state/types";

export const runtime = "nodejs";

const workloadCategorySchema = z.enum([
  "application",
  "platform",
  "data",
  "network",
  "perimeter",
  "storage",
  "telemetry",
  "background",
  "unknown",
]);

const criticalitySchema = z.enum(["low", "medium", "high"]);

const createWorkloadSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  workloadKey: z.string().trim().min(1).max(160).optional(),
  category: workloadCategorySchema,
  criticality: criticalitySchema,
  summary: z.string().trim().max(1200).nullish(),
});

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function normalizeWorkloadKey(value: string): string {
  const normalized = slugify(value);
  return normalized.length > 0 ? normalized : `workload-${randomUUID()}`;
}

function uniqueWorkloadKey(existing: Workload[], requested: string): string {
  const used = new Set(existing.map((item) => item.workloadKey.toLowerCase()));
  if (!used.has(requested.toLowerCase())) {
    return requested;
  }
  let counter = 2;
  while (used.has(`${requested}-${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${requested}-${counter}`;
}

async function updateAdoptionCounts(deviceId: string): Promise<void> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) return;
  const now = new Date().toISOString();
  await stateStore.upsertDevice({
    ...device,
    metadata: {
      ...device.metadata,
      adoption: {
        ...getAdoptionRecord(device),
        workloadCount: stateStore.getWorkloads(deviceId).length,
        assuranceCount: stateStore.getAssurances(deviceId).length,
        serviceContractCount: stateStore.getAssurances(deviceId).length,
      },
    },
    lastChangedAt: now,
  });
}

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

  return NextResponse.json({ workloads: stateStore.getWorkloads(id) });
}

export async function POST(
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

  const payload = createWorkloadSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const existing = stateStore.getWorkloads(id);
  const keyBase = normalizeWorkloadKey(payload.data.workloadKey ?? payload.data.displayName);
  const workloadKey = uniqueWorkloadKey(existing, keyBase);
  const now = new Date().toISOString();

  const workload = stateStore.upsertWorkload({
    id: randomUUID(),
    deviceId: id,
    workloadKey,
    displayName: payload.data.displayName,
    category: payload.data.category,
    criticality: payload.data.criticality,
    source: "operator",
    summary: payload.data.summary ?? undefined,
    evidenceJson: {
      source: "operator",
      method: "manual_edit",
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });

  await updateAdoptionCounts(id);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Added workload \"${workload.displayName}\" for ${device.name}`,
    context: {
      deviceId: id,
      workloadId: workload.id,
      workloadKey: workload.workloadKey,
    },
  });

  return NextResponse.json({
    workload,
    workloads: stateStore.getWorkloads(id),
  }, { status: 201 });
}
