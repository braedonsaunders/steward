import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { createResponsibility } from "@/lib/devices/contract-management";
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

const createWorkloadSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  workloadKey: z.string().trim().min(1).max(160).optional(),
  category: workloadCategorySchema,
  criticality: criticalitySchema,
  summary: z.string().trim().max(1200).nullish(),
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

  const workload = await createResponsibility({
    device,
    displayName: payload.data.displayName,
    workloadKey: payload.data.workloadKey,
    category: payload.data.category,
    criticality: payload.data.criticality,
    summary: payload.data.summary ?? undefined,
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
  }, { status: 201 });
}
