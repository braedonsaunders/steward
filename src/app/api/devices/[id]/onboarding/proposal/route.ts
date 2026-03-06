import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  getOnboardingSession,
  synthesizeOnboardingModel,
  type OnboardingSynthesis,
} from "@/lib/adoption/conversation";
import { getAdoptionRecord } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const applySchema = z.object({
  proposalIds: z.array(z.string().min(1)).min(1),
  markOnboardingComplete: z.boolean().optional(),
});

function getStoredSynthesis(deviceId: string): OnboardingSynthesis | null {
  const run = stateStore.getLatestAdoptionRun(deviceId);
  if (!run) return null;
  const value = run.profileJson.onboardingSynthesis;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as OnboardingSynthesis;
}

async function saveSynthesis(deviceId: string, synthesis: OnboardingSynthesis): Promise<void> {
  const run = stateStore.getLatestAdoptionRun(deviceId);
  if (!run) return;
  stateStore.upsertAdoptionRun({
    ...run,
    profileJson: {
      ...run.profileJson,
      onboardingSynthesis: synthesis,
    },
    summary: synthesis.summary,
    updatedAt: new Date().toISOString(),
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

  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";

  if (!refresh) {
    const stored = getStoredSynthesis(id);
    if (stored) {
      return NextResponse.json({ synthesis: stored, source: "stored" });
    }
    return NextResponse.json({ synthesis: null, source: "none" });
  }

  const session = getOnboardingSession(device.id);
  if (!session) {
    return NextResponse.json(
      { error: "Start onboarding conversation before generating recommendations." },
      { status: 400 },
    );
  }
  const synthesis = await synthesizeOnboardingModel(device, session.id);
  await saveSynthesis(id, synthesis);
  return NextResponse.json({ synthesis, source: "generated" });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = applySchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const stored = getStoredSynthesis(id);
  if (!stored) {
    return NextResponse.json({ error: "No onboarding proposal found. Generate one first." }, { status: 400 });
  }

  const selected = (stored.assurances ?? stored.contracts ?? [])
    .filter((assurance) => payload.data.proposalIds.includes(assurance.id));
  if (selected.length === 0) {
    return NextResponse.json({ error: "No matching proposals selected." }, { status: 400 });
  }

  const existingByServiceKey = new Map(
    stateStore.getAssurances(id).map((contract) => [contract.serviceKey.toLowerCase(), contract]),
  );
  const existingWorkloadsByKey = new Map(
    stateStore.getWorkloads(id).map((workload) => [workload.workloadKey.toLowerCase(), workload]),
  );

  const now = new Date().toISOString();
  const upserted = selected.map((proposal) => {
    const assuranceKey = proposal.assuranceKey.trim();
    const workloadKey = assuranceKey.toLowerCase();
    const workload = existingWorkloadsByKey.get(workloadKey)
      ?? stateStore.upsertWorkload({
        id: randomUUID(),
        deviceId: id,
        workloadKey: assuranceKey,
        displayName: proposal.displayName,
        category: "unknown",
        criticality: proposal.criticality,
        source: "onboarding_conversation",
        summary: proposal.rationale,
        evidenceJson: {
          source: "onboarding_conversation",
          proposalId: proposal.id,
        },
        createdAt: now,
        updatedAt: now,
      });
    existingWorkloadsByKey.set(workloadKey, workload);

    const existing = existingByServiceKey.get(assuranceKey.toLowerCase());
    const assurance = stateStore.upsertAssurance({
      id: existing?.id ?? randomUUID(),
      deviceId: id,
      workloadId: workload.id,
      assuranceKey,
      serviceKey: assuranceKey,
      displayName: proposal.displayName,
      criticality: proposal.criticality,
      desiredState: "running",
      checkIntervalSec: proposal.checkIntervalSec,
      monitorType: proposal.monitorType,
      requiredProtocols: proposal.requiredProtocols,
      rationale: proposal.rationale,
      configJson: {
        ...(existing?.configJson ?? existing?.policyJson ?? {}),
        source: "onboarding_conversation",
        monitorType: proposal.monitorType,
        requiredProtocols: proposal.requiredProtocols,
        rationale: proposal.rationale,
      },
      policyJson: {
        ...(existing?.policyJson ?? {}),
        source: "onboarding_conversation",
        monitorType: proposal.monitorType,
        requiredProtocols: proposal.requiredProtocols,
        rationale: proposal.rationale,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    existingByServiceKey.set(assuranceKey.toLowerCase(), assurance);
    return assurance;
  });

  const run = stateStore.getLatestAdoptionRun(id);
  const shouldComplete = payload.data.markOnboardingComplete !== false;
  if (run && shouldComplete) {
    stateStore.upsertAdoptionRun({
      ...run,
      status: "completed",
      stage: "completed",
      summary: stored.summary,
      profileJson: {
        ...run.profileJson,
        onboardingSynthesis: stored,
        appliedProposalIds: payload.data.proposalIds,
      },
      updatedAt: now,
    });

    await stateStore.upsertDevice({
      ...device,
      metadata: {
        ...device.metadata,
        adoption: {
          ...getAdoptionRecord(device),
          runStatus: "completed",
          runStage: "completed",
          unresolvedRequiredQuestions: 0,
          workloadCount: stateStore.getWorkloads(id).length,
          assuranceCount: stateStore.getAssurances(id).length,
          serviceContractCount: stateStore.getAssurances(id).length,
          profileSummary: stored.summary,
        },
      },
      lastChangedAt: now,
    });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Applied ${upserted.length} onboarding workload assurance recommendation(s) for ${device.name}`,
    context: {
      deviceId: id,
      proposalIds: payload.data.proposalIds,
      markOnboardingComplete: shouldComplete,
    },
  });

  return NextResponse.json({
    applied: upserted,
    workloads: stateStore.getWorkloads(id),
    assurances: stateStore.getAssurances(id),
    contracts: stateStore.getAssurances(id),
    onboardingCompleted: shouldComplete,
  });
}
