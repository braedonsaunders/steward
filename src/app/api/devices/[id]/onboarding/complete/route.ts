import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { completeDeviceOnboarding } from "@/lib/adoption/orchestrator";
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
const desiredStateSchema = z.enum(["running", "stopped"]);

const draftWorkloadSchema = z.object({
  workloadKey: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(160),
  category: workloadCategorySchema.optional(),
  criticality: criticalitySchema,
  summary: z.string().trim().max(1200).optional(),
  evidenceJson: z.record(z.string(), z.unknown()).optional(),
});

const draftAssuranceSchema = z.object({
  assuranceKey: z.string().trim().min(1).max(160),
  workloadKey: z.string().trim().min(1).max(160).optional(),
  displayName: z.string().trim().min(1).max(160),
  criticality: criticalitySchema,
  desiredState: desiredStateSchema.optional(),
  checkIntervalSec: z.number().int().min(15).max(3600),
  monitorType: z.string().trim().max(160).optional(),
  requiredProtocols: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  rationale: z.string().trim().max(1200).optional(),
  configJson: z.record(z.string(), z.unknown()).optional(),
});

const completeSchema = z.object({
  summary: z.string().max(4000).optional(),
  selectedProfileIds: z.array(z.string().trim().min(1).max(160)).max(64).optional(),
  selectedAccessMethodKeys: z.array(z.string().trim().min(1).max(160)).max(64).optional(),
  workloads: z.array(draftWorkloadSchema).max(128).optional(),
  assurances: z.array(draftAssuranceSchema).max(256).optional(),
  residualUnknowns: z.array(z.string().trim().min(1).max(400)).max(64).optional(),
});

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

  const payload = completeSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  try {
    const snapshot = await completeDeviceOnboarding({
      deviceId: id,
      summary: payload.data.summary,
      selectedProfileIds: payload.data.selectedProfileIds,
      selectedAccessMethodKeys: payload.data.selectedAccessMethodKeys,
      workloads: payload.data.workloads,
      assurances: payload.data.assurances,
      residualUnknowns: payload.data.residualUnknowns,
      actor: "user",
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "Failed to complete device onboarding",
      },
      { status: 400 },
    );
  }
}
