import { randomUUID } from "node:crypto";
import { adapterRegistry } from "@/lib/adapters/registry";
import type { AdapterRecord } from "@/lib/adapters/types";
import { generateDeviceAdoptionProfile, type DeviceAdoptionProfile } from "@/lib/adoption/profile";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type {
  AccessSurface,
  AdoptionQuestion,
  AdoptionRun,
  Assurance,
  AssuranceRun,
  Device,
  DeviceCredential,
  Workload,
} from "@/lib/state/types";

const ADOPTION_ONBOARDING_VERSION = 1;

export interface DeviceAdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  questions: AdoptionQuestion[];
  unresolvedRequiredQuestions: number;
  credentials: DeviceCredential[];
  accessSurfaces: AccessSurface[];
  workloads: Workload[];
  assurances: Assurance[];
  assuranceRuns: AssuranceRun[];
  // Deprecated compatibility fields while the rest of the app cuts over.
  bindings: AccessSurface[];
  serviceContracts: Assurance[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function activeAdapters(records: AdapterRecord[]): AdapterRecord[] {
  return records.filter((record) => record.enabled && record.status === "loaded");
}

function protocolSetForBinding(device: Device, profile: DeviceAdoptionProfile): string[] {
  const set = new Set<string>();
  for (const protocol of device.protocols) {
    if (protocol && protocol.trim().length > 0) set.add(protocol.trim().toLowerCase());
  }
  for (const intent of profile.credentialIntents) {
    if (intent.protocol && intent.protocol.trim().length > 0) set.add(intent.protocol.trim().toLowerCase());
  }
  if (set.size === 0) set.add("http-api");
  return Array.from(set).slice(0, 12);
}

function scoreAdapterForProtocol(
  adapter: AdapterRecord,
  device: Device,
  protocol: string,
  profile: DeviceAdoptionProfile,
): { score: number; reason: string } {
  const text = `${adapter.id} ${adapter.name} ${adapter.description}`.toLowerCase();
  let score = 0;
  const reasons: string[] = [];

  if (adapter.provides.includes("protocol")) {
    score += 0.18;
    reasons.push("protocol-capable");
  }
  if (adapter.provides.includes("enrichment")) {
    score += 0.08;
    reasons.push("enrichment-signals");
  }
  if (adapter.provides.includes("playbooks")) {
    score += 0.08;
    reasons.push("playbook-support");
  }

  if (text.includes(protocol)) {
    score += 0.35;
    reasons.push(`matches:${protocol}`);
  }

  if (text.includes(device.type)) {
    score += 0.2;
    reasons.push(`matches-type:${device.type}`);
  }

  if (device.vendor) {
    const vendorToken = device.vendor.toLowerCase().split(/[^a-z0-9]+/).find((token) => token.length >= 4);
    if (vendorToken && text.includes(vendorToken)) {
      score += 0.15;
      reasons.push(`matches-vendor:${vendorToken}`);
    }
  }

  const hinted = profile.adapterCandidates.find(
    (candidate) => candidate.adapterId === adapter.id && candidate.protocol === protocol,
  );
  if (hinted) {
    score = Math.max(score, hinted.score);
    score += 0.15;
    reasons.push(`llm-hint:${Math.round(hinted.score * 100)}%`);
  }

  if (adapter.toolSkills.length > 0) {
    score += Math.min(0.1, adapter.toolSkills.length * 0.02);
    reasons.push("tool-skills");
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    reason: reasons.join(", ") || "generic-capability-match",
  };
}

function buildBindings(
  device: Device,
  profile: DeviceAdoptionProfile,
  adapters: AdapterRecord[],
): AccessSurface[] {
  const protocols = protocolSetForBinding(device, profile);
  const createdAt = nowIso();
  const bindings: AccessSurface[] = [];

  for (const protocol of protocols) {
    const scored = adapters
      .map((adapter) => ({
        adapter,
        ...scoreAdapterForProtocol(adapter, device, protocol, profile),
      }))
      .filter((item) => item.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (scored.length === 0) {
      continue;
    }

    for (let idx = 0; idx < scored.length; idx++) {
      const item = scored[idx];
      bindings.push({
        id: randomUUID(),
        deviceId: device.id,
        adapterId: item.adapter.id,
        protocol,
        score: item.score,
        selected: idx === 0,
        reason: item.reason,
        configJson: {},
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  return bindings;
}

function buildProposedWorkloadsAndAssurances(
  device: Device,
  profile: DeviceAdoptionProfile,
): { workloads: Workload[]; assurances: Assurance[] } {
  const createdAt = nowIso();
  const workloads: Workload[] = [];
  const assurances: Assurance[] = [];

  for (const workload of profile.workloads.slice(0, 24)) {
    const workloadId = randomUUID();
    workloads.push({
      id: workloadId,
      deviceId: device.id,
      workloadKey: workload.workloadKey,
      displayName: workload.displayName,
      category: "unknown",
      criticality: workload.criticality,
      source: "onboarding_profile",
      summary: workload.reason,
      evidenceJson: {
        proposedFrom: "adoption_profile",
        workloadKey: workload.workloadKey,
      },
      createdAt,
      updatedAt: createdAt,
    });
    assurances.push({
      id: randomUUID(),
      deviceId: device.id,
      workloadId,
      assuranceKey: workload.workloadKey,
      displayName: workload.displayName,
      criticality: workload.criticality,
      desiredState: "running",
      checkIntervalSec: workload.criticality === "high" ? 30 : 120,
      monitorType: "service_presence",
      requiredProtocols: [],
      rationale: workload.reason,
      configJson: {
        reason: workload.reason,
        source: "adoption_profile",
      },
      serviceKey: workload.workloadKey,
      policyJson: {
        reason: workload.reason,
        source: "adoption_profile",
      },
      createdAt,
      updatedAt: createdAt,
    });
  }

  return { workloads, assurances };
}

function buildQuestions(
  deviceId: string,
  runId: string,
  profile: DeviceAdoptionProfile,
  existingQuestions: AdoptionQuestion[],
): AdoptionQuestion[] {
  const createdAt = nowIso();
  const existingByKey = new Map(existingQuestions.map((question) => [question.questionKey, question]));

  return profile.questions.slice(0, 8).map((draft) => {
    const existing = existingByKey.get(draft.questionKey);
    return {
      id: existing?.id ?? randomUUID(),
      runId,
      deviceId,
      questionKey: draft.questionKey,
      prompt: draft.prompt,
      options: draft.options,
      required: draft.required,
      answerJson: existing?.answerJson,
      answeredAt: existing?.answeredAt,
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: createdAt,
    };
  });
}

function upsertDeviceAdoptionMetadata(device: Device, run: AdoptionRun, profile: DeviceAdoptionProfile): Device {
  const adoption = getAdoptionRecord(device);
  const nextDevice: Device = {
    ...device,
    role: device.role ?? profile.role,
    lastChangedAt: nowIso(),
    metadata: {
      ...device.metadata,
      adoption: {
        ...adoption,
        status: "adopted",
        onboardingVersion: ADOPTION_ONBOARDING_VERSION,
        runId: run.id,
        runStatus: run.status,
        runStage: run.stage,
        profileSummary: profile.summary,
        profileConfidence: profile.confidence,
        requiredCredentials: profile.credentialIntents.map((intent) => intent.protocol),
        workloadCount: profile.workloads.length,
        assuranceCount: profile.workloads.length,
        serviceContractCount: profile.workloads.length,
        lastProfiledAt: run.updatedAt,
      },
    },
  };

  return nextDevice;
}

export async function getDeviceAdoptionSnapshot(deviceId: string): Promise<DeviceAdoptionSnapshot> {
  const run = stateStore.getLatestAdoptionRun(deviceId);
  const questions = run
    ? stateStore.getAdoptionQuestions(deviceId, { runId: run.id })
    : [];
  const unresolvedRequiredQuestions = questions.filter((question) => question.required && !question.answerJson).length;
  const credentials = stateStore.getDeviceCredentials(deviceId);
  const accessSurfaces = stateStore.getAccessSurfaces(deviceId);
  const workloads = stateStore.getWorkloads(deviceId);
  const assurances = stateStore.getAssurances(deviceId);
  const assuranceRuns = stateStore.getLatestAssuranceRuns(deviceId);

  return {
    deviceId,
    run,
    questions,
    unresolvedRequiredQuestions,
    credentials,
    accessSurfaces,
    workloads,
    assurances,
    assuranceRuns,
    bindings: accessSurfaces,
    serviceContracts: assurances,
  };
}

export async function startDeviceAdoption(
  deviceId: string,
  options?: { triggeredBy?: "user" | "steward"; force?: boolean },
): Promise<DeviceAdoptionSnapshot> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);
  if (adoptionStatus !== "adopted") {
    throw new Error("Device must be adopted before onboarding can start");
  }

  const now = nowIso();
  const existing = stateStore.getLatestAdoptionRun(deviceId);
  const existingAssuranceCount = stateStore.getAssurances(deviceId).length;
  const existingQuestions = existing && !options?.force
    ? stateStore.getAdoptionQuestions(deviceId, { runId: existing.id })
    : [];
  const run: AdoptionRun = {
    id: existing && !options?.force ? existing.id : randomUUID(),
    deviceId,
    status: "running",
    stage: "profile",
    profileJson: existing?.profileJson ?? {},
    summary: existing?.summary,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  stateStore.upsertAdoptionRun(run);

  await adapterRegistry.initialize();
  const adapters = activeAdapters(adapterRegistry.getAdapterRecords());
  const profile = await generateDeviceAdoptionProfile(device, {
    adapterIds: adapters.map((adapter) => adapter.id),
    existingAssuranceCount,
  });

  const profiledRun: AdoptionRun = {
    ...run,
    status: "running",
    stage: "adapter_binding",
    profileJson: profile as unknown as Record<string, unknown>,
    summary: profile.summary,
    updatedAt: nowIso(),
  };
  stateStore.upsertAdoptionRun(profiledRun);

  const nextDevice = upsertDeviceAdoptionMetadata(device, profiledRun, profile);
  await stateStore.upsertDevice(nextDevice);

  const bindings = buildBindings(nextDevice, profile, adapters);
  stateStore.clearAccessSurfaces(deviceId);
  for (const binding of bindings) {
    stateStore.upsertAccessSurface(binding);
  }

  const existingAssurances = stateStore.getAssurances(deviceId);
  const existingWorkloads = stateStore.getWorkloads(deviceId);
  const proposedModel = buildProposedWorkloadsAndAssurances(nextDevice, profile);
  const questions = buildQuestions(deviceId, profiledRun.id, profile, existingQuestions);
  stateStore.deleteAdoptionQuestionsForRun(profiledRun.id);
  for (const question of questions) {
    stateStore.upsertAdoptionQuestion(question);
  }

  const unresolvedRequired = questions.filter((question) => question.required && !question.answerJson).length;
  const validatedProtocols = stateStore.getValidatedCredentialProtocols(deviceId);
  const requiredProtocols = Array.from(new Set(profile.credentialIntents.map((intent) => intent.protocol)));
  const missingRequiredCredentials = requiredProtocols.filter(
    (protocol) => !validatedProtocols.includes(protocol),
  );
  const nextStage: AdoptionRun["stage"] = unresolvedRequired > 0
    ? "questions"
    : missingRequiredCredentials.length > 0
      ? "credentials"
      : "activation";
  const terminalRun: AdoptionRun = {
    ...profiledRun,
    status: "awaiting_user",
    stage: nextStage,
    profileJson: {
      ...profiledRun.profileJson,
      proposedWorkloads: proposedModel.workloads,
      proposedAssurances: proposedModel.assurances,
      proposedContracts: proposedModel.assurances,
      onboardingConversationRequired: true,
      missingRequiredCredentials,
      existingAssuranceCount,
      existingServiceContractsCount: existingAssuranceCount,
      existingAssuranceKeys: existingAssurances.map((contract) => contract.assuranceKey),
      existingServiceContractKeys: existingAssurances.map((contract) => contract.serviceKey),
      existingWorkloadKeys: existingWorkloads.map((workload) => workload.workloadKey),
    },
    updatedAt: nowIso(),
  };
  stateStore.upsertAdoptionRun(terminalRun);

  await stateStore.upsertDevice({
    ...nextDevice,
    metadata: {
      ...nextDevice.metadata,
      adoption: {
        ...getAdoptionRecord(nextDevice),
        runStatus: terminalRun.status,
        runStage: terminalRun.stage,
        workloadCount: existingWorkloads.length,
        assuranceCount: existingAssurances.length,
        serviceContractCount: existingAssurances.length,
        unresolvedRequiredQuestions: unresolvedRequired,
      },
    },
    lastChangedAt: nowIso(),
  });

  await stateStore.addAction({
    actor: options?.triggeredBy === "user" ? "user" : "steward",
    kind: "discover",
    message: `Device adoption workflow started for ${nextDevice.name}`,
    context: {
      deviceId: nextDevice.id,
      runId: terminalRun.id,
      status: terminalRun.status,
      stage: terminalRun.stage,
      unresolvedRequiredQuestions: unresolvedRequired,
      credentialIntents: profile.credentialIntents.map((intent) => intent.protocol),
    },
  });

  return getDeviceAdoptionSnapshot(deviceId);
}

export async function finalizeAdoptionRunIfReady(deviceId: string): Promise<DeviceAdoptionSnapshot> {
  const run = stateStore.getLatestAdoptionRun(deviceId);
  if (!run || run.status === "completed" || run.status === "failed") {
    return getDeviceAdoptionSnapshot(deviceId);
  }

  const syncDeviceAdoptionStage = async (
    stageRun: AdoptionRun,
    unresolvedQuestions: number,
  ): Promise<void> => {
    const device = stateStore.getDeviceById(deviceId);
    if (!device) return;

    await stateStore.upsertDevice({
      ...device,
      metadata: {
        ...device.metadata,
        adoption: {
          ...getAdoptionRecord(device),
          runStatus: stageRun.status,
          runStage: stageRun.stage,
          unresolvedRequiredQuestions: unresolvedQuestions,
        },
      },
      lastChangedAt: nowIso(),
    });
  };

  const questions = stateStore.getAdoptionQuestions(deviceId, { runId: run.id });
  const unresolvedRequired = questions.filter((question) => question.required && !question.answerJson).length;
  if (unresolvedRequired > 0) {
    const waiting: AdoptionRun = {
      ...run,
      status: "awaiting_user",
      stage: "questions",
      updatedAt: nowIso(),
    };
    stateStore.upsertAdoptionRun(waiting);
    await syncDeviceAdoptionStage(waiting, unresolvedRequired);
    return getDeviceAdoptionSnapshot(deviceId);
  }

  const profileCredentialIntents = Array.isArray(run.profileJson.credentialIntents)
    ? run.profileJson.credentialIntents
      .filter((item): item is { protocol: string } => (
        typeof item === "object"
        && item !== null
        && "protocol" in item
        && typeof (item as { protocol?: unknown }).protocol === "string"
      ))
    : [];
  const requiredProtocols = Array.from(
    new Set(profileCredentialIntents.map((intent) => intent.protocol.trim().toLowerCase()).filter(Boolean)),
  );
  const validatedProtocols = new Set(
    stateStore.getValidatedCredentialProtocols(deviceId).map((protocol) => protocol.trim().toLowerCase()),
  );
  const missingRequiredCredentials = requiredProtocols.filter((protocol) => !validatedProtocols.has(protocol));
  if (missingRequiredCredentials.length > 0) {
    const waiting: AdoptionRun = {
      ...run,
      status: "awaiting_user",
      stage: "credentials",
      profileJson: {
        ...run.profileJson,
        missingRequiredCredentials,
      },
      updatedAt: nowIso(),
    };
    stateStore.upsertAdoptionRun(waiting);
    await syncDeviceAdoptionStage(waiting, 0);
    return getDeviceAdoptionSnapshot(deviceId);
  }

  const completed: AdoptionRun = {
    ...run,
    status: "completed",
    stage: "completed",
    updatedAt: nowIso(),
  };
  stateStore.upsertAdoptionRun(completed);

  const device = stateStore.getDeviceById(deviceId);
  if (device) {
    await stateStore.upsertDevice({
      ...device,
      metadata: {
        ...device.metadata,
        adoption: {
          ...getAdoptionRecord(device),
          runStatus: completed.status,
          runStage: completed.stage,
          unresolvedRequiredQuestions: 0,
        },
      },
      lastChangedAt: nowIso(),
    });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Device adoption workflow completed for ${deviceId}`,
    context: { deviceId, runId: completed.id },
  });

  return getDeviceAdoptionSnapshot(deviceId);
}
