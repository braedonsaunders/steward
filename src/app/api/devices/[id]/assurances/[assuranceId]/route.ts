import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  deleteAssurance,
  updateAssurance,
} from "@/lib/devices/contract-management";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const criticalitySchema = z.enum(["low", "medium", "high"]);
const desiredStateSchema = z.enum(["running", "stopped"]);

const updateAssuranceSchema = z.object({
  displayName: z.string().trim().min(1).max(160).optional(),
  workloadId: z.string().trim().min(1).max(160).nullable().optional(),
  criticality: criticalitySchema.optional(),
  desiredState: desiredStateSchema.optional(),
  checkIntervalSec: z.number().int().min(15).max(3600).optional(),
  monitorType: z.string().trim().max(160).nullable().optional(),
  requiredProtocols: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  rationale: z.string().trim().max(1200).nullable().optional(),
  configJson: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assuranceId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assuranceId } = await params;
  const payload = updateAssuranceSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const existing = stateStore.getAssuranceById(assuranceId);
  if (!existing || existing.deviceId !== id) {
    return NextResponse.json({ error: "Assurance not found" }, { status: 404 });
  }

  const workloadId = payload.data.workloadId === null
    ? undefined
    : payload.data.workloadId ?? existing.workloadId;
  if (workloadId) {
    const workload = stateStore.getWorkloadById(workloadId);
    if (!workload || workload.deviceId !== id) {
      return NextResponse.json({ error: "Workload not found" }, { status: 404 });
    }
  }

  const assurance = await updateAssurance({
    device,
    assurance: existing,
    workloadId,
    displayName: payload.data.displayName,
    criticality: payload.data.criticality,
    desiredState: payload.data.desiredState,
    checkIntervalSec: payload.data.checkIntervalSec,
    monitorType: payload.data.monitorType ?? undefined,
    clearMonitorType: payload.data.monitorType === null,
    requiredProtocols: payload.data.requiredProtocols,
    rationale: payload.data.rationale ?? undefined,
    clearRationale: payload.data.rationale === null,
    configJson: payload.data.configJson,
    metadata: {
      actor: "user",
      workloadSource: "operator",
      method: "manual_edit",
      origin: "device_assurances_api",
    },
  });

  return NextResponse.json({
    assurance,
    assurances: stateStore.getAssurances(id),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; assuranceId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assuranceId } = await params;
  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const existing = stateStore.getAssuranceById(assuranceId);
  if (!existing || existing.deviceId !== id) {
    return NextResponse.json({ error: "Assurance not found" }, { status: 404 });
  }

  await deleteAssurance({
    device,
    assurance: existing,
    metadata: {
      actor: "user",
      workloadSource: "operator",
      method: "manual_edit",
      origin: "device_assurances_api",
    },
  });

  return NextResponse.json({
    ok: true,
    assurances: stateStore.getAssurances(id),
  });
}
