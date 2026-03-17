import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  deleteResponsibility,
  updateResponsibility,
} from "@/lib/devices/contract-management";
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
    return NextResponse.json({ error: "Responsibility not found" }, { status: 404 });
  }

  const workload = await updateResponsibility({
    device,
    responsibility: existing,
    displayName: payload.data.displayName,
    category: payload.data.category,
    criticality: payload.data.criticality,
    summary: payload.data.summary ?? undefined,
    clearSummary: payload.data.summary === null,
    metadata: {
      actor: "user",
      workloadSource: "operator",
      method: "manual_edit",
      origin: "device_workloads_api",
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
    return NextResponse.json({ error: "Responsibility not found" }, { status: 404 });
  }

  await deleteResponsibility({
    device,
    responsibility: existing,
    metadata: {
      actor: "user",
      workloadSource: "operator",
      method: "manual_edit",
      origin: "device_workloads_api",
    },
  });

  return NextResponse.json({
    ok: true,
    workloads: stateStore.getWorkloads(id),
  });
}
