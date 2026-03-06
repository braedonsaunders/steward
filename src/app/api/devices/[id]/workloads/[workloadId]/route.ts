import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { getAdoptionRecord } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";

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

const updateWorkloadSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  category: workloadCategorySchema.optional(),
  criticality: criticalitySchema.optional(),
  summary: z.string().trim().max(1200).nullable().optional(),
});

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; workloadId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, workloadId } = await params;
  const payload = updateWorkloadSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const existing = stateStore.getWorkloadById(workloadId);
  if (!existing || existing.deviceId !== id) {
    return NextResponse.json({ error: "Workload not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const workload = stateStore.upsertWorkload({
    ...existing,
    displayName: payload.data.displayName ?? existing.displayName,
    category: payload.data.category ?? existing.category,
    criticality: payload.data.criticality ?? existing.criticality,
    summary: payload.data.summary === null ? undefined : (payload.data.summary ?? existing.summary),
    source: "operator",
    evidenceJson: {
      ...(existing.evidenceJson ?? {}),
      source: "operator",
      method: "manual_edit",
      updatedAt: now,
    },
    updatedAt: now,
  });

  await updateAdoptionCounts(id);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated workload \"${workload.displayName}\" for ${device.name}`,
    context: {
      deviceId: id,
      workloadId: workload.id,
    },
  });

  return NextResponse.json({
    workload,
    workloads: stateStore.getWorkloads(id),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; workloadId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, workloadId } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const existing = stateStore.getWorkloadById(workloadId);
  if (!existing || existing.deviceId !== id) {
    return NextResponse.json({ error: "Workload not found" }, { status: 404 });
  }

  stateStore.deleteWorkload(workloadId);

  await updateAdoptionCounts(id);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Deleted workload \"${existing.displayName}\" for ${device.name}`,
    context: {
      deviceId: id,
      workloadId,
    },
  });

  return NextResponse.json({
    ok: true,
    workloads: stateStore.getWorkloads(id),
  });
}
