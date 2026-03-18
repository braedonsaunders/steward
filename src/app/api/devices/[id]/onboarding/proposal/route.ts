import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import {
  getOnboardingSession,
  synthesizeOnboardingModel,
  type OnboardingSynthesis,
} from "@/lib/adoption/conversation";
import {
  completeDeviceOnboarding,
  getDeviceAdoptionSnapshot,
} from "@/lib/adoption/orchestrator";
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
  try {
    const synthesis = await synthesizeOnboardingModel(device, session.id);
    await saveSynthesis(id, synthesis);
    return NextResponse.json({ synthesis, source: "generated" });
  } catch (error) {
    const stored = getStoredSynthesis(id);
    const warning = error instanceof Error ? error.message : String(error);
    return NextResponse.json({
      synthesis: stored,
      source: stored ? "stored" : "none",
      warning,
    });
  }
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

  const shouldComplete = payload.data.markOnboardingComplete !== false;
  const draftSnapshot = await getDeviceAdoptionSnapshot(id);
  const workloadDrafts = selected.map((proposal) => ({
    workloadKey: proposal.assuranceKey.trim(),
    displayName: proposal.displayName,
    category: "unknown" as const,
    criticality: proposal.criticality,
    summary: proposal.rationale,
  }));
  const assuranceDrafts = selected.map((proposal) => ({
    assuranceKey: proposal.assuranceKey.trim(),
    workloadKey: proposal.assuranceKey.trim(),
    displayName: proposal.displayName,
    criticality: proposal.criticality,
    desiredState: "running" as const,
    checkIntervalSec: proposal.checkIntervalSec,
    monitorType: proposal.monitorType,
    requiredProtocols: proposal.requiredProtocols,
    rationale: proposal.rationale,
    configJson: {
      source: "onboarding_conversation",
      proposalId: proposal.id,
    },
  }));

  const finalSnapshot = shouldComplete
    ? await completeDeviceOnboarding({
      deviceId: id,
      summary: stored.summary,
      selectedProfileIds: draftSnapshot.draft?.selectedProfileIds,
      selectedAccessMethodKeys: draftSnapshot.draft?.selectedAccessMethodKeys,
      workloads: workloadDrafts,
      assurances: assuranceDrafts,
      actor: "user",
    })
    : draftSnapshot;

  await stateStore.addAction({
    actor: "user",
    kind: "config",
      message: `Applied ${selected.length} onboarding responsibility assurance recommendation(s) for ${device.name}`,
    context: {
      deviceId: id,
      proposalIds: payload.data.proposalIds,
      markOnboardingComplete: shouldComplete,
    },
  });

  return NextResponse.json({
    applied: assuranceDrafts,
    workloads: finalSnapshot.workloads,
    assurances: finalSnapshot.assurances,
    contracts: finalSnapshot.assurances,
    onboardingCompleted: shouldComplete,
  });
}
