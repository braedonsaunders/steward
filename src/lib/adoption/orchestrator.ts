import { randomUUID } from "node:crypto";
import { adapterRegistry } from "@/lib/adapters/registry";
import type { AdapterProfileMatch } from "@/lib/adapters/types";
import {
  generateDeviceAdoptionProfile,
  type DeviceAdoptionProfile,
} from "@/lib/adoption/profile";
import { buildObservedAccessMethods } from "@/lib/devices/management-model";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { getDb } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import type {
  AccessMethod,
  AccessSurface,
  AdoptionQuestion,
  AdoptionRun,
  Assurance,
  AssuranceRun,
  Device,
  DeviceCredential,
  DeviceProfileBinding,
  OnboardingCredentialRequest,
  OnboardingDraft,
  OnboardingDraftAssurance,
  OnboardingDraftWorkload,
  Workload,
} from "@/lib/state/types";

const ADOPTION_ONBOARDING_VERSION = 2;

export interface DeviceAdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  questions: AdoptionQuestion[];
  unresolvedRequiredQuestions: number;
  credentials: DeviceCredential[];
  accessMethods: AccessMethod[];
  profiles: DeviceProfileBinding[];
  workloads: Workload[];
  assurances: Assurance[];
  assuranceRuns: AssuranceRun[];
  draft: OnboardingDraft | null;
  // Compatibility fields while the UI/API finishes cutting over.
  accessSurfaces: AccessSurface[];
  bindings: AccessSurface[];
  serviceContracts: Assurance[];
}

export interface CompleteDeviceOnboardingInput {
  deviceId: string;
  summary?: string;
  selectedProfileIds?: string[];
  selectedAccessMethodKeys?: string[];
  workloads?: OnboardingDraftWorkload[];
  assurances?: OnboardingDraftAssurance[];
  residualUnknowns?: string[];
  actor?: "user" | "steward";
}

export interface UpdateDeviceOnboardingDraftInput {
  deviceId: string;
  summary?: string;
  selectedProfileIds?: string[];
  selectedAccessMethodKeys?: string[];
  workloads?: OnboardingDraftWorkload[];
  assurances?: OnboardingDraftAssurance[];
  nextActions?: string[];
  unresolvedQuestions?: string[];
  residualUnknowns?: string[];
  dismissedWorkloadKeys?: string[];
  dismissedAssuranceKeys?: string[];
  actor?: "user" | "steward";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCredentialProtocol(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "http" || normalized === "https") return "http-api";
  if (normalized === "mqtts") return "mqtt";
  if (normalized === "windows") return "winrm";
  return normalized;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function readDraft(run: AdoptionRun | null): OnboardingDraft | null {
  if (!run) return null;
  const raw = run.profileJson.onboardingDraft;
  if (!isRecord(raw)) {
    return null;
  }

  const workloadRaw = Array.isArray(raw.workloads) ? raw.workloads : [];
  const assuranceRaw = Array.isArray(raw.assurances) ? raw.assurances : [];
  const credentialRequestsRaw = Array.isArray(raw.credentialRequests) ? raw.credentialRequests : [];

  return {
    version: Number(raw.version ?? ADOPTION_ONBOARDING_VERSION) || ADOPTION_ONBOARDING_VERSION,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    selectedProfileIds: readStringArray(raw.selectedProfileIds),
    selectedAccessMethodKeys: readStringArray(raw.selectedAccessMethodKeys),
    credentialRequests: credentialRequestsRaw
      .filter(isRecord)
      .map((entry) => ({
        protocol: String(entry.protocol ?? "").trim().toLowerCase(),
        reason: typeof entry.reason === "string" ? entry.reason : "Credential required",
        priority: (entry.priority === "high" || entry.priority === "low" || entry.priority === "medium"
          ? entry.priority
          : "medium") as OnboardingCredentialRequest["priority"],
      }))
      .filter((entry) => entry.protocol.length > 0),
    workloads: workloadRaw
      .filter(isRecord)
      .map((entry) => ({
        workloadKey: String(entry.workloadKey ?? "").trim(),
        displayName: String(entry.displayName ?? "").trim(),
        category: typeof entry.category === "string" ? entry.category as OnboardingDraftWorkload["category"] : undefined,
        criticality: (entry.criticality === "high" || entry.criticality === "low" || entry.criticality === "medium"
          ? entry.criticality
          : "medium") as OnboardingDraftWorkload["criticality"],
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        evidenceJson: isRecord(entry.evidenceJson) ? entry.evidenceJson : {},
      }))
      .filter((entry) => entry.workloadKey.length > 0 && entry.displayName.length > 0),
    assurances: assuranceRaw
      .filter(isRecord)
      .map((entry) => ({
        assuranceKey: String(entry.assuranceKey ?? "").trim(),
        workloadKey: typeof entry.workloadKey === "string" && entry.workloadKey.trim().length > 0
          ? entry.workloadKey.trim()
          : undefined,
        displayName: String(entry.displayName ?? "").trim(),
        criticality: (entry.criticality === "high" || entry.criticality === "low" || entry.criticality === "medium"
          ? entry.criticality
          : "medium") as OnboardingDraftAssurance["criticality"],
        desiredState: (entry.desiredState === "stopped" ? "stopped" : "running") as OnboardingDraftAssurance["desiredState"],
        checkIntervalSec: Number.isFinite(Number(entry.checkIntervalSec))
          ? Math.max(15, Math.min(3600, Math.floor(Number(entry.checkIntervalSec))))
          : 120,
        monitorType: typeof entry.monitorType === "string" ? entry.monitorType : undefined,
        requiredProtocols: readStringArray(entry.requiredProtocols),
        rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
        configJson: isRecord(entry.configJson) ? entry.configJson : {},
      }))
      .filter((entry) => entry.assuranceKey.length > 0 && entry.displayName.length > 0),
    nextActions: readStringArray(raw.nextActions),
    unresolvedQuestions: readStringArray(raw.unresolvedQuestions),
    residualUnknowns: readStringArray(raw.residualUnknowns),
    dismissedWorkloadKeys: readStringArray(raw.dismissedWorkloadKeys),
    dismissedAssuranceKeys: readStringArray(raw.dismissedAssuranceKeys),
    completionReady: Boolean(raw.completionReady),
  };
}

function isDraftSuppressed(run: AdoptionRun | null, device?: Device | null): boolean {
  const adoption = device ? getAdoptionRecord(device) : {};
  const deviceMarker = typeof adoption.draftSuppressedAt === "string" && adoption.draftSuppressedAt.trim().length > 0;
  if (!run) {
    return deviceMarker;
  }
  return typeof run.profileJson.onboardingDraftDeletedAt === "string"
    && run.profileJson.onboardingDraftDeletedAt.trim().length > 0
    && !readDraft(run)
    || (deviceMarker && !readDraft(run));
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const key = keyFn(item).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function sanitizeWorkloadDraft(item: OnboardingDraftWorkload): OnboardingDraftWorkload | null {
  const workloadKey = item.workloadKey.trim();
  const displayName = item.displayName.trim();
  if (!workloadKey || !displayName) return null;
  return {
    workloadKey,
    displayName,
    category: item.category ?? "unknown",
    criticality: item.criticality,
    summary: item.summary?.trim() || undefined,
    evidenceJson: item.evidenceJson ?? {},
  };
}

function sanitizeAssuranceDraft(item: OnboardingDraftAssurance): OnboardingDraftAssurance | null {
  const assuranceKey = item.assuranceKey.trim();
  const displayName = item.displayName.trim();
  if (!assuranceKey || !displayName) return null;
  return {
    assuranceKey,
    workloadKey: item.workloadKey?.trim() || undefined,
    displayName,
    criticality: item.criticality,
    desiredState: item.desiredState === "stopped" ? "stopped" : "running",
    checkIntervalSec: Math.max(15, Math.min(3600, Math.floor(item.checkIntervalSec))),
    monitorType: item.monitorType?.trim() || undefined,
    requiredProtocols: dedupeByKey(item.requiredProtocols ?? [], (value) => value),
    rationale: item.rationale?.trim() || undefined,
    configJson: item.configJson ?? {},
  };
}

function profilePriority(kind: DeviceProfileBinding["kind"]): number {
  if (kind === "primary") return 0;
  if (kind === "fallback") return 1;
  return 2;
}

function readProfileDraftWorkloads(binding: DeviceProfileBinding): OnboardingDraftWorkload[] {
  const raw = Array.isArray(binding.draftJson.defaultWorkloads) ? binding.draftJson.defaultWorkloads : [];
  return raw
    .filter(isRecord)
    .map((entry) => sanitizeWorkloadDraft({
      workloadKey: String(entry.workloadKey ?? "").trim(),
      displayName: String(entry.displayName ?? "").trim(),
      category: typeof entry.category === "string" ? entry.category as OnboardingDraftWorkload["category"] : undefined,
      criticality: entry.criticality === "high" || entry.criticality === "low" ? entry.criticality : "medium",
      summary: typeof entry.summary === "string" ? entry.summary : undefined,
      evidenceJson: isRecord(entry.evidence) ? entry.evidence : {},
    }))
    .filter((entry): entry is OnboardingDraftWorkload => Boolean(entry));
}

function readProfileDraftAssurances(binding: DeviceProfileBinding): OnboardingDraftAssurance[] {
  const raw = Array.isArray(binding.draftJson.defaultAssurances) ? binding.draftJson.defaultAssurances : [];
  return raw
    .filter(isRecord)
    .map((entry) => sanitizeAssuranceDraft({
      assuranceKey: String(entry.assuranceKey ?? "").trim(),
      workloadKey: typeof entry.workloadKey === "string" ? entry.workloadKey.trim() : undefined,
      displayName: String(entry.displayName ?? "").trim(),
      criticality: entry.criticality === "high" || entry.criticality === "low" ? entry.criticality : "medium",
      desiredState: entry.desiredState === "stopped" ? "stopped" : "running",
      checkIntervalSec: Number.isFinite(Number(entry.checkIntervalSec)) ? Number(entry.checkIntervalSec) : 120,
      monitorType: typeof entry.monitorType === "string" ? entry.monitorType : undefined,
      requiredProtocols: readStringArray(entry.requiredProtocols),
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
      configJson: isRecord(entry.config) ? entry.config : {},
    }))
    .filter((entry): entry is OnboardingDraftAssurance => Boolean(entry));
}

function mergeWorkloadDrafts(...sets: OnboardingDraftWorkload[][]): OnboardingDraftWorkload[] {
  const merged = new Map<string, OnboardingDraftWorkload>();
  for (const set of sets) {
    for (const item of set) {
      const normalized = sanitizeWorkloadDraft(item);
      if (!normalized) continue;
      const key = normalized.workloadKey.trim().toLowerCase();
      if (merged.has(key)) {
        merged.delete(key);
      }
      merged.set(key, normalized);
    }
  }
  return Array.from(merged.values());
}

function mergeAssuranceDrafts(...sets: OnboardingDraftAssurance[][]): OnboardingDraftAssurance[] {
  const merged = new Map<string, OnboardingDraftAssurance>();
  for (const set of sets) {
    for (const item of set) {
      const normalized = sanitizeAssuranceDraft(item);
      if (!normalized) continue;
      const key = normalized.assuranceKey.trim().toLowerCase();
      if (merged.has(key)) {
        merged.delete(key);
      }
      merged.set(key, normalized);
    }
  }
  return Array.from(merged.values());
}

function assureDraftCoverage(
  workloads: OnboardingDraftWorkload[],
  assurances: OnboardingDraftAssurance[],
  dismissedAssuranceKeys?: string[],
): OnboardingDraftAssurance[] {
  const dismissed = new Set((dismissedAssuranceKeys ?? []).map((key) => key.trim().toLowerCase()).filter(Boolean));
  const covered = new Set<string>();
  const next = assurances.filter((assurance) => {
    const key = assurance.assuranceKey.trim().toLowerCase();
    if (!key || dismissed.has(key)) {
      return false;
    }
    if (assurance.workloadKey?.trim()) {
      covered.add(assurance.workloadKey.trim().toLowerCase());
    }
    covered.add(key);
    return true;
  });

  for (const workload of workloads) {
    const workloadKey = workload.workloadKey.trim().toLowerCase();
    if (!workloadKey || covered.has(workloadKey) || dismissed.has(workloadKey)) {
      continue;
    }

    next.push({
      assuranceKey: workload.workloadKey,
      workloadKey: workload.workloadKey,
      displayName: workload.displayName,
      criticality: workload.criticality,
      desiredState: "running",
      checkIntervalSec: workload.criticality === "high" ? 60 : 120,
      monitorType: "workload_presence",
      requiredProtocols: [],
      rationale: workload.summary ?? `Keep ${workload.displayName} within Steward's committed operating envelope.`,
      configJson: {},
    });
    covered.add(workloadKey);
  }

  return next;
}

function mergeCredentialRequests(
  requiredProtocols: string[],
  generated: Array<{ protocol: string; reason: string; priority: "high" | "medium" | "low" }>,
  existing: OnboardingCredentialRequest[],
): OnboardingCredentialRequest[] {
  const requests = [
    ...requiredProtocols.map((protocol) => ({
      protocol: normalizeCredentialProtocol(protocol),
      reason: `Credential required for ${protocol} management.`,
      priority: "high" as const,
    })),
    ...generated.map((item) => ({
      protocol: normalizeCredentialProtocol(item.protocol),
      reason: item.reason,
      priority: item.priority,
    })),
    ...existing.map((item) => ({
      protocol: normalizeCredentialProtocol(item.protocol),
      reason: item.reason,
      priority: item.priority,
    })),
  ].filter((item) => item.protocol.length > 0);

  return dedupeByKey(requests, (item) => item.protocol);
}

function selectedProfileIdsForDraft(
  matches: AdapterProfileMatch[],
  existing: DeviceProfileBinding[],
  draft: OnboardingDraft | null,
): string[] {
  const available = new Set(matches.map((match) => match.profileId));
  const fromDraft = draft
    ? draft.selectedProfileIds.filter((profileId) => available.has(profileId))
    : [];
  if (fromDraft.length > 0) {
    return fromDraft;
  }

  const stickyExisting = existing
    .filter((binding) => ["active", "verified", "selected"].includes(binding.status))
    .map((binding) => binding.profileId)
    .filter((profileId) => available.has(profileId));
  if (stickyExisting.length > 0) {
    return stickyExisting;
  }

  const sorted = [...matches].sort((left, right) => {
    if ((left.kind ?? "primary") !== (right.kind ?? "primary")) {
      return profilePriority((left.kind ?? "primary") as DeviceProfileBinding["kind"])
        - profilePriority((right.kind ?? "primary") as DeviceProfileBinding["kind"]);
    }
    return (right.confidence ?? 0) - (left.confidence ?? 0);
  });
  if (sorted.length === 1) {
    return [sorted[0].profileId];
  }
  const top = sorted[0];
  if (!top) return [];
  if ((top.kind ?? "primary") === "primary" && (top.confidence ?? 0) >= 0.78) {
    return [top.profileId];
  }
  return [];
}

function buildProfileBindings(args: {
  deviceId: string;
  matches: AdapterProfileMatch[];
  existing: DeviceProfileBinding[];
  selectedProfileIds: string[];
  completed: boolean;
}): DeviceProfileBinding[] {
  const now = nowIso();
  const existingByProfileId = new Map(args.existing.map((binding) => [binding.profileId, binding]));
  const selected = new Set(args.selectedProfileIds);
  const bindings: DeviceProfileBinding[] = [];

  for (const match of args.matches) {
    const existing = existingByProfileId.get(match.profileId);
    const stickyStatus = existing?.status === "active" || existing?.status === "verified"
      ? existing.status
      : undefined;

    bindings.push({
      id: existing?.id ?? randomUUID(),
      deviceId: args.deviceId,
      profileId: match.profileId,
      adapterId: match.adapterId,
      name: match.name ?? match.profileId,
      kind: (match.kind ?? "primary") as DeviceProfileBinding["kind"],
      confidence: Math.max(0, Math.min(1, match.confidence ?? 0)),
      status: stickyStatus ?? (selected.has(match.profileId) ? (args.completed ? "active" : "selected") : "candidate"),
      summary: match.summary,
      requiredAccessMethods: dedupeByKey(match.requiredAccessMethods ?? [], (item) => item),
      requiredCredentialProtocols: dedupeByKey(match.requiredCredentialProtocols ?? [], (item) => item),
      evidenceJson: {
        ...(existing?.evidenceJson ?? {}),
        ...(match.evidence ?? {}),
      },
      draftJson: {
        defaultWorkloads: match.defaultWorkloads ?? existing?.draftJson.defaultWorkloads ?? [],
        defaultAssurances: match.defaultAssurances ?? existing?.draftJson.defaultAssurances ?? [],
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  for (const existing of args.existing) {
    if (bindings.some((binding) => binding.profileId === existing.profileId)) {
      continue;
    }
    if (!["active", "verified", "selected"].includes(existing.status)) {
      continue;
    }
    bindings.push({
      ...existing,
      status: args.completed ? existing.status : "selected",
      updatedAt: now,
    });
  }

  return bindings.sort((left, right) => {
    if (left.status !== right.status) {
      const rank = (value: DeviceProfileBinding["status"]) => (
        value === "active" ? 0
          : value === "verified" ? 1
            : value === "selected" ? 2
              : value === "candidate" ? 3
                : 4
      );
      return rank(left.status) - rank(right.status);
    }
    if (left.kind !== right.kind) {
      return profilePriority(left.kind) - profilePriority(right.kind);
    }
    return right.confidence - left.confidence;
  });
}

function preferredAccessKeyForKind(kind: string, accessMethods: AccessMethod[]): string | null {
  const candidates = accessMethods
    .filter((method) => method.kind === kind)
    .sort((left, right) => {
      const statusRank = (value: AccessMethod["status"]) => (
        value === "validated" ? 0
          : value === "credentialed" ? 1
            : value === "observed" ? 2
              : 3
      );
      if ((left.port !== undefined) !== (right.port !== undefined)) {
        return left.port !== undefined ? -1 : 1;
      }
      if (left.selected !== right.selected) {
        return left.selected ? -1 : 1;
      }
      if (left.status !== right.status) {
        return statusRank(left.status) - statusRank(right.status);
      }
      if (left.secure !== right.secure) {
        return left.secure ? -1 : 1;
      }
      return (left.port ?? 0) - (right.port ?? 0);
    });
  return candidates[0]?.key ?? null;
}

function resolveSelectedAccessMethodKeys(candidateKeys: string[], accessMethods: AccessMethod[]): string[] {
  const accessMethodByKey = new Map(accessMethods.map((method) => [method.key, method]));
  return dedupeByKey(
    candidateKeys
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) => {
        const existing = accessMethodByKey.get(key);
        const preferred = preferredAccessKeyForKind(existing?.kind ?? key, accessMethods);
        return preferred ?? existing?.key ?? null;
      })
      .filter((key): key is string => Boolean(key)),
    (item) => item,
  );
}

function selectedAccessMethodKeysForDraft(
  profiles: DeviceProfileBinding[],
  accessMethods: AccessMethod[],
  draft: OnboardingDraft | null,
): string[] {
  const available = new Set(accessMethods.map((method) => method.key));
  const fromDraft = draft
    ? draft.selectedAccessMethodKeys.filter((key) => available.has(key))
    : [];
  if (fromDraft.length > 0) {
    return resolveSelectedAccessMethodKeys(fromDraft, accessMethods);
  }

  const requiredKinds = dedupeByKey(
    profiles
      .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
      .flatMap((profile) => profile.requiredAccessMethods),
    (item) => item,
  );

  return resolveSelectedAccessMethodKeys(requiredKinds, accessMethods);
}

function buildDraftSummary(device: Device, profiles: DeviceProfileBinding[], generatedSummary: string, existingDraft: OnboardingDraft | null): string {
  if (existingDraft?.summary?.trim()) {
    return existingDraft.summary.trim();
  }
  const selected = profiles.filter((profile) => ["selected", "verified", "active"].includes(profile.status));
  if (selected.length > 0) {
    return `${device.name} is being onboarded as ${selected.map((profile) => profile.name).join(", ")}. Steward is preparing the endpoint contract and management responsibilities.`;
  }
  return generatedSummary.trim().length > 0
    ? generatedSummary.trim()
    : `Steward is building a management contract for ${device.name}.`;
}

function buildRunStage(args: {
  accessMethods: AccessMethod[];
  profiles: DeviceProfileBinding[];
  missingRequiredCredentials: string[];
  draft: OnboardingDraft | null;
  completed: boolean;
}): AdoptionRun["stage"] {
  if (args.completed) return "completed";
  if (args.accessMethods.length === 0) return "access";
  if (!args.profiles.some((profile) => ["selected", "verified", "active"].includes(profile.status))) {
    return "profiles";
  }
  if (args.missingRequiredCredentials.length > 0) {
    return "credentials";
  }
  return "contract";
}

function toCompatAccessSurface(profile: DeviceProfileBinding): AccessSurface {
  return {
    id: profile.id,
    deviceId: profile.deviceId,
    adapterId: profile.profileId,
    protocol: profile.requiredAccessMethods[0] ?? "unknown",
    score: profile.confidence,
    selected: ["selected", "verified", "active"].includes(profile.status),
    reason: profile.summary,
    configJson: profile.draftJson,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function buildSnapshotFromState(deviceId: string): DeviceAdoptionSnapshot {
  const run = stateStore.getLatestAdoptionRun(deviceId);
  const credentials = stateStore.getDeviceCredentials(deviceId);
  const accessMethods = stateStore.getAccessMethods(deviceId);
  const profiles = stateStore.getDeviceProfiles(deviceId);
  const workloads = stateStore.getWorkloads(deviceId);
  const assurances = stateStore.getAssurances(deviceId);
  const assuranceRuns = stateStore.getLatestAssuranceRuns(deviceId);
  const draft = readDraft(run);
  const accessSurfaces = profiles.map(toCompatAccessSurface);

  return {
    deviceId,
    run,
    questions: [],
    unresolvedRequiredQuestions: draft?.unresolvedQuestions.length ?? 0,
    credentials,
    accessMethods,
    profiles,
    workloads,
    assurances,
    assuranceRuns,
    draft,
    accessSurfaces,
    bindings: accessSurfaces,
    serviceContracts: assurances,
  };
}

function readGeneratedProfile(run: AdoptionRun | null): DeviceAdoptionProfile | null {
  if (!run) return null;
  const raw = run.profileJson.generatedProfile;
  if (!isRecord(raw)) return null;
  if (typeof raw.summary !== "string" || !Array.isArray(raw.workloads) || !Array.isArray(raw.credentialIntents)) {
    return null;
  }
  return raw as unknown as DeviceAdoptionProfile;
}

async function syncDeviceAdoptionState(
  deviceId: string,
  options?: {
    createIfMissing?: boolean;
  },
): Promise<DeviceAdoptionSnapshot> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);
  let run = stateStore.getLatestAdoptionRun(deviceId);
  if (!run && !options?.createIfMissing) {
    return buildSnapshotFromState(deviceId);
  }
  if (!run && adoptionStatus !== "adopted") {
    throw new Error("Device must be adopted before onboarding can start");
  }

  const now = nowIso();
  if (!run) {
    run = {
      id: randomUUID(),
      deviceId,
      status: "awaiting_user",
      stage: "draft",
      profileJson: {},
      createdAt: now,
      updatedAt: now,
    };
  }

  await adapterRegistry.initialize();
  const credentials = stateStore.getDeviceCredentials(deviceId);
  const existingAccessMethods = stateStore.getAccessMethods(deviceId);
  const existingProfiles = stateStore.getDeviceProfiles(deviceId);
  const existingDraft = run.status === "completed" ? null : readDraft(run);
  const draftSuppressed = run.status === "completed" || (isDraftSuppressed(run, device) && !existingDraft);
  const matches = await adapterRegistry.getDeviceProfileMatches(device);
  const selectedProfileIds = selectedProfileIdsForDraft(matches, existingProfiles, existingDraft);
  const profiles = buildProfileBindings({
    deviceId,
    matches,
    existing: existingProfiles,
    selectedProfileIds,
    completed: run.status === "completed",
  });

  let accessMethods = buildObservedAccessMethods({
    device,
    credentials,
    existing: existingAccessMethods,
    selectedKeys: existingDraft?.selectedAccessMethodKeys ?? [],
  });
  const selectedAccessMethodKeys = selectedAccessMethodKeysForDraft(profiles, accessMethods, existingDraft);
  accessMethods = buildObservedAccessMethods({
    device,
    credentials,
    existing: existingAccessMethods,
    selectedKeys: selectedAccessMethodKeys,
  });

  const selectedProfiles = profiles.filter((profile) => ["selected", "verified", "active"].includes(profile.status));
  const requiredCredentialProtocols = dedupeByKey(
    selectedProfiles.flatMap((profile) => profile.requiredCredentialProtocols),
    (item) => item,
  ).map(normalizeCredentialProtocol);

  const availableCredentialProtocols = new Set(
    credentials
      .filter((credential) => credential.status !== "invalid")
      .map((credential) => normalizeCredentialProtocol(credential.protocol)),
  );
  const missingRequiredCredentials = requiredCredentialProtocols.filter(
    (protocol) => !availableCredentialProtocols.has(protocol),
  );
  const dismissedWorkloadKeys = dedupeByKey(existingDraft?.dismissedWorkloadKeys ?? [], (item) => item);
  const dismissedAssuranceKeys = dedupeByKey(existingDraft?.dismissedAssuranceKeys ?? [], (item) => item);
  const dismissedWorkloadKeySet = new Set(dismissedWorkloadKeys.map((item) => item.toLowerCase()));

  const generatedProfile = readGeneratedProfile(run)
    ?? await generateDeviceAdoptionProfile(device, {
      adapterIds: profiles.map((profile) => profile.profileId),
      existingAssuranceCount: stateStore.getAssurances(deviceId).length,
    });

  const draftWorkloads = draftSuppressed
    ? []
    : mergeWorkloadDrafts(
      ...selectedProfiles.map(readProfileDraftWorkloads),
      generatedProfile.workloads.map((workload) => ({
        workloadKey: workload.workloadKey,
        displayName: workload.displayName,
        category: "unknown",
        criticality: workload.criticality,
        summary: workload.reason,
        evidenceJson: {
          proposedFrom: "generated-profile",
        },
      })),
      existingDraft?.workloads ?? [],
    ).filter((workload) => !dismissedWorkloadKeySet.has(workload.workloadKey.toLowerCase()));

  const draftAssurances = draftSuppressed
    ? []
    : assureDraftCoverage(
      draftWorkloads,
      mergeAssuranceDrafts(
        ...selectedProfiles.map(readProfileDraftAssurances),
        existingDraft?.assurances ?? [],
      ),
      dismissedAssuranceKeys,
    );

  const draft: OnboardingDraft | null = draftSuppressed
    ? null
    : {
      version: ADOPTION_ONBOARDING_VERSION,
      summary: buildDraftSummary(device, profiles, generatedProfile.summary, existingDraft),
      selectedProfileIds,
      selectedAccessMethodKeys,
      credentialRequests: mergeCredentialRequests(
        requiredCredentialProtocols,
        generatedProfile.credentialIntents,
        existingDraft?.credentialRequests ?? [],
      ),
      workloads: draftWorkloads,
      assurances: draftAssurances,
      nextActions: dedupeByKey(
        [
          ...generatedProfile.watchItems.map((item) => `Watch ${item}`),
          ...(missingRequiredCredentials.length > 0
            ? missingRequiredCredentials.map((protocol) => `Collect ${protocol} credentials or confirm another management path.`)
            : ["Review Steward's proposed responsibilities and complete onboarding when ready."]),
        ],
        (item) => item,
      ).slice(0, 8),
      unresolvedQuestions: dedupeByKey(
        generatedProfile.questions.map((question) => question.prompt),
        (item) => item,
      ).slice(0, 6),
      residualUnknowns: existingDraft?.residualUnknowns ?? [],
      dismissedWorkloadKeys,
      dismissedAssuranceKeys,
      completionReady: selectedProfileIds.length > 0 && draftWorkloads.length > 0,
    };

  const stage = buildRunStage({
    accessMethods,
    profiles,
    missingRequiredCredentials,
    draft,
    completed: run.status === "completed",
  });
  const nextRun: AdoptionRun = {
    ...run,
    status: run.status === "completed" ? "completed" : "awaiting_user",
    stage,
    profileJson: {
      ...run.profileJson,
      generatedProfile,
      ...(draft
        ? {
          onboardingDraft: draft,
        }
        : {}),
      ...(draftSuppressed
        ? {
          onboardingDraftDeletedAt:
            typeof run.profileJson.onboardingDraftDeletedAt === "string"
              ? run.profileJson.onboardingDraftDeletedAt
              : now,
        }
        : {}),
      missingRequiredCredentials,
      selectedProfileIds,
      selectedAccessMethodKeys,
      profileCandidates: profiles.map((profile) => ({
        profileId: profile.profileId,
        status: profile.status,
        confidence: profile.confidence,
      })),
    },
    summary: draft?.summary ?? run.summary ?? generatedProfile.summary,
    updatedAt: now,
  };

  if (!draft) {
    delete nextRun.profileJson.onboardingDraft;
  } else {
    delete nextRun.profileJson.onboardingDraftDeletedAt;
  }

  stateStore.upsertAdoptionRun(nextRun);
  stateStore.clearAccessMethods(deviceId);
  for (const method of accessMethods) {
    stateStore.upsertAccessMethod(method);
  }
  stateStore.clearDeviceProfiles(deviceId);
  for (const profile of profiles) {
    stateStore.upsertDeviceProfile(profile);
  }

  const adoptionRecord = {
    ...getAdoptionRecord(device),
    status: "adopted",
    onboardingVersion: ADOPTION_ONBOARDING_VERSION,
    runId: nextRun.id,
    runStatus: nextRun.status,
    runStage: nextRun.stage,
    profileSummary: draft?.summary ?? run.summary ?? generatedProfile.summary,
    profileCount: profiles.length,
    selectedProfileIds,
    requiredCredentials: requiredCredentialProtocols,
    workloadCount: stateStore.getWorkloads(deviceId).length,
    assuranceCount: stateStore.getAssurances(deviceId).length,
    serviceContractCount: stateStore.getAssurances(deviceId).length,
    unresolvedRequiredQuestions: draft?.unresolvedQuestions.length ?? 0,
    missingRequiredCredentials,
    lastProfiledAt: nextRun.updatedAt,
  } as Record<string, unknown>;
  if (draftSuppressed) {
    adoptionRecord.draftSuppressedAt =
      typeof getAdoptionRecord(device).draftSuppressedAt === "string"
        ? String(getAdoptionRecord(device).draftSuppressedAt)
        : now;
  } else {
    delete adoptionRecord.draftSuppressedAt;
  }

  await stateStore.upsertDevice({
    ...device,
    role: device.role ?? generatedProfile.role,
    lastChangedAt: now,
    metadata: {
      ...device.metadata,
      adoption: adoptionRecord,
    },
  });

  return buildSnapshotFromState(deviceId);
}

function commitOnboardingContract(args: {
  device: Device;
  run: AdoptionRun;
  profiles: DeviceProfileBinding[];
  accessMethods: AccessMethod[];
  draft: OnboardingDraft;
  actor: "user" | "steward";
}): void {
  const db = getDb();
  const now = nowIso();

  const tx = db.transaction(() => {
    const selectedProfileIds = new Set(args.draft.selectedProfileIds);
    const selectedAccessKeys = new Set(args.draft.selectedAccessMethodKeys);
    const workloadIdByKey = new Map<string, string>();

    const existingWorkloads = db.prepare(`
      SELECT id, workloadKey
      FROM workloads
      WHERE deviceId = ?
    `).all(args.device.id) as Array<{ id: string; workloadKey: string }>;
    for (const row of existingWorkloads) {
      workloadIdByKey.set(String(row.workloadKey).toLowerCase(), String(row.id));
    }

    const upsertWorkload = db.prepare(`
      INSERT OR REPLACE INTO workloads (
        id, deviceId, workloadKey, displayName, category, criticality, source, summary, evidenceJson, createdAt, updatedAt
      )
      VALUES (
        @id, @deviceId, @workloadKey, @displayName, @category, @criticality, @source, @summary, @evidenceJson, @createdAt, @updatedAt
      )
    `);
    const upsertAssurance = db.prepare(`
      INSERT OR REPLACE INTO assurances (
        id, deviceId, workloadId, assuranceKey, displayName, criticality, desiredState, checkIntervalSec,
        monitorType, requiredProtocols, rationale, configJson, serviceKey, policyJson, createdAt, updatedAt
      )
      VALUES (
        @id, @deviceId, @workloadId, @assuranceKey, @displayName, @criticality, @desiredState, @checkIntervalSec,
        @monitorType, @requiredProtocols, @rationale, @configJson, @serviceKey, @policyJson, @createdAt, @updatedAt
      )
    `);

    for (const workload of args.draft.workloads) {
      const lookupKey = workload.workloadKey.toLowerCase();
      const workloadId = workloadIdByKey.get(lookupKey) ?? `workload-${randomUUID()}`;
      workloadIdByKey.set(lookupKey, workloadId);
      upsertWorkload.run({
        id: workloadId,
        deviceId: args.device.id,
        workloadKey: workload.workloadKey,
        displayName: workload.displayName,
        category: workload.category ?? "unknown",
        criticality: workload.criticality,
        source: "onboarding_conversation",
        summary: workload.summary ?? null,
        evidenceJson: JSON.stringify({
          ...(workload.evidenceJson ?? {}),
          committedFrom: "onboarding",
        }),
        createdAt: now,
        updatedAt: now,
      });
    }

    const existingAssurances = db.prepare(`
      SELECT id, assuranceKey
      FROM assurances
      WHERE deviceId = ?
    `).all(args.device.id) as Array<{ id: string; assuranceKey: string }>;
    const assuranceIdByKey = new Map(existingAssurances.map((row) => [String(row.assuranceKey).toLowerCase(), String(row.id)]));

    for (const assurance of args.draft.assurances) {
      const assuranceId = assuranceIdByKey.get(assurance.assuranceKey.toLowerCase()) ?? `assurance-${randomUUID()}`;
      const workloadKey = assurance.workloadKey?.toLowerCase() || assurance.assuranceKey.toLowerCase();
      const workloadId = workloadIdByKey.get(workloadKey) ?? null;
      upsertAssurance.run({
        id: assuranceId,
        deviceId: args.device.id,
        workloadId,
        assuranceKey: assurance.assuranceKey,
        displayName: assurance.displayName,
        criticality: assurance.criticality,
        desiredState: assurance.desiredState ?? "running",
        checkIntervalSec: assurance.checkIntervalSec,
        monitorType: assurance.monitorType ?? null,
        requiredProtocols: JSON.stringify(assurance.requiredProtocols ?? []),
        rationale: assurance.rationale ?? null,
        configJson: JSON.stringify({
          ...(assurance.configJson ?? {}),
          committedFrom: "onboarding",
        }),
        serviceKey: assurance.assuranceKey,
        policyJson: JSON.stringify({
          ...(assurance.configJson ?? {}),
          rationale: assurance.rationale ?? null,
          committedFrom: "onboarding",
        }),
        createdAt: now,
        updatedAt: now,
      });
    }

    db.prepare(`
      UPDATE device_profiles
      SET status = CASE
        WHEN profileId IN (${args.profiles.map(() => "?").join(", ") || "''"}) AND profileId IN (${Array.from(selectedProfileIds).map(() => "?").join(", ") || "''"})
          THEN 'active'
        WHEN profileId IN (${args.profiles.map(() => "?").join(", ") || "''"})
          THEN 'candidate'
        ELSE status
      END,
      updatedAt = ?
      WHERE deviceId = ?
    `).run(
      ...args.profiles.map((profile) => profile.profileId),
      ...Array.from(selectedProfileIds),
      ...args.profiles.map((profile) => profile.profileId),
      now,
      args.device.id,
    );

    db.prepare(`
      UPDATE access_methods
      SET selected = CASE WHEN key IN (${Array.from(selectedAccessKeys).map(() => "?").join(", ") || "''"}) THEN 1 ELSE 0 END,
          updatedAt = ?
      WHERE deviceId = ?
    `).run(...Array.from(selectedAccessKeys), now, args.device.id);

    db.prepare(`
      UPDATE adoption_runs
      SET status = 'completed',
          stage = 'completed',
          profileJson = ?,
          summary = ?,
          updatedAt = ?
      WHERE id = ?
    `).run(
      JSON.stringify((() => {
        const profileJson = {
          ...args.run.profileJson,
          committedAt: now,
          committedBy: args.actor,
          onboardingDraftDeletedAt: now,
          selectedProfileIds: Array.from(selectedProfileIds),
          selectedAccessMethodKeys: Array.from(selectedAccessKeys),
        } as Record<string, unknown>;
        delete profileJson.onboardingDraft;
        return profileJson;
      })()),
      args.draft.summary,
      now,
      args.run.id,
    );

    db.prepare(`
      UPDATE devices
      SET role = ?,
          lastChangedAt = ?,
          metadata = ?
      WHERE id = ?
    `).run(
      args.device.role ?? null,
      now,
      JSON.stringify({
        ...args.device.metadata,
        adoption: (() => {
          const adoption = {
            ...getAdoptionRecord(args.device),
            status: "adopted",
            onboardingVersion: ADOPTION_ONBOARDING_VERSION,
            runId: args.run.id,
            runStatus: "completed",
            runStage: "completed",
            profileSummary: args.draft.summary,
            selectedProfileIds: Array.from(selectedProfileIds),
            requiredCredentials: dedupeByKey(
              args.profiles
                .filter((profile) => selectedProfileIds.has(profile.profileId))
                .flatMap((profile) => profile.requiredCredentialProtocols),
              (item) => item,
            ),
            workloadCount: args.draft.workloads.length,
            assuranceCount: args.draft.assurances.length,
            serviceContractCount: args.draft.assurances.length,
            unresolvedRequiredQuestions: 0,
            residualUnknowns: args.draft.residualUnknowns,
            lastProfiledAt: now,
            completedAt: now,
            draftSuppressedAt: now,
          } as Record<string, unknown>;
          return adoption;
        })(),
      }),
      args.device.id,
    );
  });

  tx();
}

export async function getDeviceAdoptionSnapshot(deviceId: string): Promise<DeviceAdoptionSnapshot> {
  const device = stateStore.getDeviceById(deviceId);
  if (device && getDeviceAdoptionStatus(device) === "adopted") {
    return syncDeviceAdoptionState(deviceId, { createIfMissing: true });
  }
  return buildSnapshotFromState(deviceId);
}

export async function startDeviceAdoption(
  deviceId: string,
  options?: { triggeredBy?: "user" | "steward"; force?: boolean },
): Promise<DeviceAdoptionSnapshot> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    throw new Error(`Device not found: ${deviceId}`);
  }

  if (getDeviceAdoptionStatus(device) !== "adopted") {
    throw new Error("Device must be adopted before onboarding can start");
  }

  if (options?.force) {
    stateStore.clearAccessMethods(deviceId);
    stateStore.clearDeviceProfiles(deviceId);
  }

  const snapshot = await syncDeviceAdoptionState(deviceId, { createIfMissing: true });

  await stateStore.addAction({
    actor: options?.triggeredBy === "user" ? "user" : "steward",
    kind: "discover",
    message: `Device onboarding draft refreshed for ${device.name}`,
    context: {
      deviceId: device.id,
      runId: snapshot.run?.id,
      stage: snapshot.run?.stage,
      selectedProfileIds: snapshot.draft?.selectedProfileIds ?? [],
      selectedAccessMethodKeys: snapshot.draft?.selectedAccessMethodKeys ?? [],
    },
  });

  return snapshot;
}

export async function finalizeAdoptionRunIfReady(deviceId: string): Promise<DeviceAdoptionSnapshot> {
  return getDeviceAdoptionSnapshot(deviceId);
}

export async function completeDeviceOnboarding(input: CompleteDeviceOnboardingInput): Promise<DeviceAdoptionSnapshot> {
  const snapshot = await syncDeviceAdoptionState(input.deviceId, { createIfMissing: true });
  const device = stateStore.getDeviceById(input.deviceId);
  const run = stateStore.getLatestAdoptionRun(input.deviceId);
  if (!device || !run) {
    throw new Error("Device onboarding state is unavailable");
  }

  const profiles = snapshot.profiles;
  const accessMethods = snapshot.accessMethods;
  const fallbackDraft = snapshot.draft ?? {
    version: ADOPTION_ONBOARDING_VERSION,
    summary: `Steward completed onboarding for ${device.name}.`,
    selectedProfileIds: [],
    selectedAccessMethodKeys: [],
    credentialRequests: [],
    workloads: [],
    assurances: [],
    nextActions: [],
    unresolvedQuestions: [],
    residualUnknowns: [],
    dismissedWorkloadKeys: [],
    dismissedAssuranceKeys: [],
    completionReady: false,
  };

  const selectedProfileIds = dedupeByKey(
    (input.selectedProfileIds ?? fallbackDraft.selectedProfileIds).filter((profileId) =>
      profiles.some((profile) => profile.profileId === profileId),
    ),
    (item) => item,
  );
  if (selectedProfileIds.length === 0 && profiles.length > 0) {
    const best = profiles.find((profile) => profile.kind === "primary") ?? profiles[0];
    if (best) {
      selectedProfileIds.push(best.profileId);
    }
  }

  const selectedProfiles = profiles.filter((profile) => selectedProfileIds.includes(profile.profileId));
  const requiredAccessKinds = dedupeByKey(
    selectedProfiles.flatMap((profile) => profile.requiredAccessMethods),
    (item) => item,
  );
  const fallbackSelectedAccessKeys = requiredAccessKinds
    .map((kind) => preferredAccessKeyForKind(kind, accessMethods))
    .filter((key): key is string => Boolean(key));
  const selectedAccessMethodKeys = resolveSelectedAccessMethodKeys(
    (input.selectedAccessMethodKeys ?? fallbackDraft.selectedAccessMethodKeys.length > 0
      ? fallbackDraft.selectedAccessMethodKeys
      : fallbackSelectedAccessKeys
    ).filter((key) => accessMethods.some((method) => method.key === key)),
    accessMethods,
  );

  const workloads = mergeWorkloadDrafts(input.workloads ?? [], fallbackDraft.workloads);
  if (workloads.length === 0) {
    throw new Error("Onboarding cannot complete without at least one committed workload.");
  }

  const assurances = assureDraftCoverage(
    workloads,
    mergeAssuranceDrafts(input.assurances ?? [], fallbackDraft.assurances),
  );

  const summary = input.summary?.trim() || fallbackDraft.summary || `Steward completed onboarding for ${device.name}.`;
  const draft: OnboardingDraft = {
    ...fallbackDraft,
    summary,
    selectedProfileIds,
    selectedAccessMethodKeys,
    workloads,
    assurances,
    residualUnknowns: dedupeByKey(
      [...(input.residualUnknowns ?? []), ...fallbackDraft.residualUnknowns],
      (item) => item,
    ),
    dismissedWorkloadKeys: [],
    dismissedAssuranceKeys: [],
    unresolvedQuestions: [],
    nextActions: [],
    completionReady: true,
  };

  commitOnboardingContract({
    device,
    run,
    profiles,
    accessMethods,
    draft,
    actor: input.actor ?? "user",
  });

  await stateStore.addAction({
    actor: input.actor ?? "user",
    kind: "config",
    message: `Completed onboarding for ${device.name}`,
    context: {
      deviceId: device.id,
      runId: run.id,
      selectedProfileIds,
      selectedAccessMethodKeys,
      workloadKeys: workloads.map((workload) => workload.workloadKey),
      assuranceKeys: assurances.map((assurance) => assurance.assuranceKey),
      residualUnknowns: draft.residualUnknowns,
    },
  });

  return buildSnapshotFromState(input.deviceId);
}

export async function updateDeviceOnboardingDraft(input: UpdateDeviceOnboardingDraftInput): Promise<DeviceAdoptionSnapshot> {
  const snapshot = await syncDeviceAdoptionState(input.deviceId, { createIfMissing: true });
  const device = stateStore.getDeviceById(input.deviceId);
  const run = stateStore.getLatestAdoptionRun(input.deviceId);
  if (!device || !run) {
    throw new Error("Device onboarding state is unavailable");
  }

  const fallbackDraft = snapshot.draft ?? {
    version: ADOPTION_ONBOARDING_VERSION,
    summary: `Steward is onboarding ${device.name}.`,
    selectedProfileIds: [],
    selectedAccessMethodKeys: [],
    credentialRequests: [],
    workloads: [],
    assurances: [],
    nextActions: [],
    unresolvedQuestions: [],
    residualUnknowns: [],
    dismissedWorkloadKeys: [],
    dismissedAssuranceKeys: [],
    completionReady: false,
  };
  const availableProfileIds = new Set(snapshot.profiles.map((profile) => profile.profileId));
  const availableAccessMethodKeys = new Set(snapshot.accessMethods.map((method) => method.key));
  const workloads = mergeWorkloadDrafts(input.workloads ?? fallbackDraft.workloads);
  const assurances = mergeAssuranceDrafts(input.assurances ?? fallbackDraft.assurances);
  const dismissedWorkloadKeys = dedupeByKey(
    (input.dismissedWorkloadKeys ?? fallbackDraft.dismissedWorkloadKeys ?? []).filter((key) => key.trim().length > 0),
    (item) => item,
  ).filter((key) => !workloads.some((workload) => workload.workloadKey.toLowerCase() === key.trim().toLowerCase()));
  const dismissedAssuranceKeys = dedupeByKey(
    (input.dismissedAssuranceKeys ?? fallbackDraft.dismissedAssuranceKeys ?? []).filter((key) => key.trim().length > 0),
    (item) => item,
  ).filter((key) => !assurances.some((assurance) => assurance.assuranceKey.toLowerCase() === key.trim().toLowerCase()));

  const nextDraft: OnboardingDraft = {
    ...fallbackDraft,
    summary: input.summary?.trim() ?? fallbackDraft.summary,
    selectedProfileIds: dedupeByKey(
      (input.selectedProfileIds ?? fallbackDraft.selectedProfileIds).filter((profileId) => availableProfileIds.has(profileId)),
      (item) => item,
    ),
    selectedAccessMethodKeys: dedupeByKey(
      (input.selectedAccessMethodKeys ?? fallbackDraft.selectedAccessMethodKeys).filter((key) => availableAccessMethodKeys.has(key)),
      (item) => item,
    ),
    workloads,
    assurances,
    nextActions: input.nextActions
      ? dedupeByKey(input.nextActions.filter((item) => item.trim().length > 0), (item) => item)
      : fallbackDraft.nextActions,
    unresolvedQuestions: input.unresolvedQuestions
      ? dedupeByKey(input.unresolvedQuestions.filter((item) => item.trim().length > 0), (item) => item)
      : fallbackDraft.unresolvedQuestions,
    residualUnknowns: input.residualUnknowns
      ? dedupeByKey(input.residualUnknowns.filter((item) => item.trim().length > 0), (item) => item)
      : fallbackDraft.residualUnknowns,
    dismissedWorkloadKeys,
    dismissedAssuranceKeys,
    completionReady: fallbackDraft.completionReady,
  };

  const profileJson: Record<string, unknown> = {
    ...run.profileJson,
    onboardingDraft: nextDraft,
  };
  delete profileJson.onboardingDraftDeletedAt;

  stateStore.upsertAdoptionRun({
    ...run,
    profileJson,
    updatedAt: nowIso(),
  });

  await stateStore.upsertDevice({
    ...device,
    metadata: {
      ...device.metadata,
      adoption: (() => {
        const adoption = { ...getAdoptionRecord(device) } as Record<string, unknown>;
        delete adoption.draftSuppressedAt;
        return adoption;
      })(),
    },
    lastChangedAt: nowIso(),
  });

  await stateStore.addAction({
    actor: input.actor ?? "user",
    kind: "config",
    message: `Updated onboarding draft for ${device.name}`,
    context: {
      deviceId: device.id,
      runId: run.id,
    },
  });

  return syncDeviceAdoptionState(input.deviceId, { createIfMissing: true });
}

export async function resetDeviceOnboardingDraft(
  deviceId: string,
  actor: "user" | "steward" = "user",
): Promise<DeviceAdoptionSnapshot> {
  const snapshot = await syncDeviceAdoptionState(deviceId, { createIfMissing: true });
  const device = stateStore.getDeviceById(deviceId);
  const run = stateStore.getLatestAdoptionRun(deviceId);
  if (!device || !run) {
    throw new Error("Device onboarding state is unavailable");
  }

  const profileJson: Record<string, unknown> = { ...run.profileJson };
  delete profileJson.onboardingDraft;
  delete profileJson.onboardingDraftDeletedAt;

  stateStore.upsertAdoptionRun({
    ...run,
    profileJson,
    updatedAt: nowIso(),
  });

  await stateStore.upsertDevice({
    ...device,
    metadata: {
      ...device.metadata,
      adoption: (() => {
        const adoption = { ...getAdoptionRecord(device) } as Record<string, unknown>;
        delete adoption.draftSuppressedAt;
        return adoption;
      })(),
    },
    lastChangedAt: nowIso(),
  });

  await stateStore.addAction({
    actor,
    kind: "config",
    message: `Reset onboarding draft for ${device.name}`,
    context: {
      deviceId: device.id,
      runId: run.id,
      previousDraftSummary: snapshot.draft?.summary ?? null,
    },
  });

  return syncDeviceAdoptionState(deviceId, { createIfMissing: true });
}

export async function deleteDeviceOnboardingDraft(
  deviceId: string,
  actor: "user" | "steward" = "user",
): Promise<DeviceAdoptionSnapshot> {
  const snapshot = await syncDeviceAdoptionState(deviceId, { createIfMissing: true });
  const device = stateStore.getDeviceById(deviceId);
  const run = stateStore.getLatestAdoptionRun(deviceId);
  if (!device || !run) {
    throw new Error("Device onboarding state is unavailable");
  }

  const profileJson: Record<string, unknown> = { ...run.profileJson };
  delete profileJson.onboardingDraft;
  const deletedAt = nowIso();
  profileJson.onboardingDraftDeletedAt = deletedAt;

  stateStore.upsertAdoptionRun({
    ...run,
    profileJson,
    updatedAt: deletedAt,
  });

  await stateStore.upsertDevice({
    ...device,
    metadata: {
      ...device.metadata,
      adoption: {
        ...getAdoptionRecord(device),
        draftSuppressedAt: deletedAt,
      },
    },
    lastChangedAt: deletedAt,
  });

  await stateStore.addAction({
    actor,
    kind: "config",
    message: `Deleted onboarding draft for ${device.name}`,
    context: {
      deviceId: device.id,
      runId: run.id,
      previousDraftSummary: snapshot.draft?.summary ?? null,
    },
  });

  return syncDeviceAdoptionState(deviceId, { createIfMissing: true });
}
