import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { createAssurance } from "@/lib/devices/contract-management";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const criticalitySchema = z.enum(["low", "medium", "high"]);
const desiredStateSchema = z.enum(["running", "stopped"]);

const createAssuranceSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  assuranceKey: z.string().trim().min(1).max(160).optional(),
  workloadId: z.string().trim().min(1).max(160).nullable().optional(),
  criticality: criticalitySchema,
  desiredState: desiredStateSchema.default("running"),
  checkIntervalSec: z.number().int().min(15).max(3600),
  monitorType: z.string().trim().max(160).nullish(),
  requiredProtocols: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  rationale: z.string().trim().max(1200).nullish(),
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

  return NextResponse.json({ assurances: stateStore.getAssurances(id) });
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

  const payload = createAssuranceSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const workloadId = payload.data.workloadId ?? undefined;
  if (workloadId) {
    const workload = stateStore.getWorkloadById(workloadId);
    if (!workload || workload.deviceId !== id) {
      return NextResponse.json({ error: "Workload not found" }, { status: 404 });
    }
  }

  const assurance = await createAssurance({
    device,
    displayName: payload.data.displayName,
    assuranceKey: payload.data.assuranceKey,
    workloadId,
    criticality: payload.data.criticality,
    desiredState: payload.data.desiredState,
    checkIntervalSec: payload.data.checkIntervalSec,
    monitorType: payload.data.monitorType ?? undefined,
    requiredProtocols: payload.data.requiredProtocols,
    rationale: payload.data.rationale ?? undefined,
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
  }, { status: 201 });
}
