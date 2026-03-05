import { randomUUID } from "node:crypto";
import { adapterRegistry } from "@/lib/adapters/registry";
import type { AdapterRecord } from "@/lib/adapters/types";
import { generateDeviceAdoptionProfile, type DeviceAdoptionProfile } from "@/lib/adoption/profile";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type {
  AdoptionQuestion,
  AdoptionRun,
  Device,
  DeviceAdapterBinding,
  DeviceCredential,
  ServiceContract,
} from "@/lib/state/types";

const ADOPTION_ONBOARDING_VERSION = 1;

export interface DeviceAdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  questions: AdoptionQuestion[];
  unresolvedRequiredQuestions: number;
  credentials: DeviceCredential[];
  bindings: DeviceAdapterBinding[];
  serviceContracts: ServiceContract[];
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
): DeviceAdapterBinding[] {
  const protocols = protocolSetForBinding(device, profile);
  const createdAt = nowIso();
  const bindings: DeviceAdapterBinding[] = [];

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

function buildServiceContracts(device: Device, profile: DeviceAdoptionProfile): ServiceContract[] {
  const createdAt = nowIso();
  return profile.criticalServices.slice(0, 24).map((service) => ({
    id: randomUUID(),
    deviceId: device.id,
    serviceKey: service.serviceKey,
    displayName: service.displayName,
    criticality: service.criticality,
    desiredState: "running",
    checkIntervalSec: service.criticality === "high" ? 30 : 120,
    policyJson: {
      reason: service.reason,
      source: "adoption_profile",
    },
    createdAt,
    updatedAt: createdAt,
  }));
}

function buildQuestions(device: Device, runId: string, profile: DeviceAdoptionProfile): AdoptionQuestion[] {
  const createdAt = nowIso();
  return profile.questions.map((question) => ({
    id: randomUUID(),
    runId,
    deviceId: device.id,
    questionKey: question.questionKey,
    prompt: question.prompt,
    options: question.options,
    required: question.required,
    answerJson: undefined,
    answeredAt: undefined,
    createdAt,
    updatedAt: createdAt,
  }));
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
  const bindings = stateStore.getDeviceAdapterBindings(deviceId);
  const serviceContracts = stateStore.getServiceContracts(deviceId);

  return {
    deviceId,
    run,
    questions,
    unresolvedRequiredQuestions,
    credentials,
    bindings,
    serviceContracts,
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
  stateStore.clearDeviceAdapterBindings(deviceId);
  for (const binding of bindings) {
    stateStore.upsertDeviceAdapterBinding(binding);
  }

  const serviceContracts = buildServiceContracts(nextDevice, profile);
  stateStore.clearServiceContracts(deviceId);
  for (const contract of serviceContracts) {
    stateStore.upsertServiceContract(contract);
  }

  const questions = buildQuestions(nextDevice, profiledRun.id, profile);
  stateStore.deleteAdoptionQuestionsForRun(profiledRun.id);
  for (const question of questions) {
    stateStore.upsertAdoptionQuestion(question);
  }

  const unresolvedRequired = questions.filter((question) => question.required).length;
  const terminalRun: AdoptionRun = {
    ...profiledRun,
    status: unresolvedRequired > 0 ? "awaiting_user" : "completed",
    stage: unresolvedRequired > 0 ? "questions" : "completed",
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
