import { randomUUID } from "node:crypto";
import { getAdoptionRecord } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { Assurance, Device, Workload, WorkloadCategory } from "@/lib/state/types";

type ContractActor = "user" | "steward";
type ContractSource = Workload["source"];

export interface ResponsibilitySelector {
  id?: string;
  key?: string;
  name?: string;
}

export interface AssuranceSelector {
  id?: string;
  key?: string;
  name?: string;
}

export interface ContractMutationMetadata {
  actor?: ContractActor;
  workloadSource?: ContractSource;
  method?: string;
  origin?: string;
}

export interface ResolveResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  matches?: Array<{
    id: string;
    key: string;
    displayName: string;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactText(value: string | undefined, maxChars = 120): string | undefined {
  if (!value) {
    return undefined;
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars - 3)}...`;
}

function slugifyContractKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function normalizeWorkloadKey(value: string): string {
  const normalized = slugifyContractKey(value);
  return normalized.length > 0 ? normalized : `workload-${randomUUID()}`;
}

function normalizeAssuranceKey(value: string): string {
  const normalized = slugifyContractKey(value);
  return normalized.length > 0 ? normalized : `assurance-${randomUUID()}`;
}

function uniqueWorkloadKey(existing: Workload[], requested: string): string {
  const used = new Set(existing.map((item) => item.workloadKey.toLowerCase()));
  if (!used.has(requested.toLowerCase())) {
    return requested;
  }
  let counter = 2;
  while (used.has(`${requested}-${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${requested}-${counter}`;
}

function uniqueAssuranceKey(existing: Assurance[], requested: string): string {
  const used = new Set(existing.map((item) => item.assuranceKey.toLowerCase()));
  if (!used.has(requested.toLowerCase())) {
    return requested;
  }
  let counter = 2;
  while (used.has(`${requested}-${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${requested}-${counter}`;
}

function inferWorkloadCategoryFromText(value: string): WorkloadCategory {
  const normalized = value.toLowerCase();
  if (/(backup|database|postgres|mysql|mariadb|redis|mongodb)/.test(normalized)) return "data";
  if (/(nas|share|storage|raid|snapshot|disk)/.test(normalized)) return "storage";
  if (/(firewall|vpn|gateway|routing|dns|dhcp|switch|wifi|wireless|network)/.test(normalized)) return "network";
  if (/(ssl|certificate|auth|identity|perimeter|waf)/.test(normalized)) return "perimeter";
  if (/(monitor|telemetry|metrics|logging|alert|heartbeat)/.test(normalized)) return "telemetry";
  if (/(docker|container|kubernetes|vm|hypervisor|platform|runtime)/.test(normalized)) return "platform";
  if (/(cron|schedule|worker|queue|replication|sync|job)/.test(normalized)) return "background";
  if (/(app|service|api|server|print|printer|plex|home assistant|media)/.test(normalized)) return "application";
  return "unknown";
}

async function updateAdoptionCounts(deviceId: string): Promise<void> {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    return;
  }
  const now = nowIso();
  await stateStore.upsertDevice({
    ...device,
    metadata: {
      ...device.metadata,
      adoption: {
        ...getAdoptionRecord(device),
        workloadCount: stateStore.getWorkloads(deviceId).length,
        assuranceCount: stateStore.getAssurances(deviceId).length,
        serviceContractCount: stateStore.getAssurances(deviceId).length,
      },
    },
    lastChangedAt: now,
  });
}

function actorForMutation(metadata?: ContractMutationMetadata): ContractActor {
  return metadata?.actor ?? "user";
}

function sourceForMutation(metadata?: ContractMutationMetadata): ContractSource {
  return metadata?.workloadSource ?? "operator";
}

function methodForMutation(metadata?: ContractMutationMetadata): string {
  return metadata?.method?.trim() || "manual_edit";
}

function resolveMatchKey(item: { workloadKey?: unknown; assuranceKey?: unknown }): string {
  if (typeof item.workloadKey === "string" && item.workloadKey.trim().length > 0) {
    return item.workloadKey;
  }
  if (typeof item.assuranceKey === "string" && item.assuranceKey.trim().length > 0) {
    return item.assuranceKey;
  }
  return "";
}

function resolveByName<T extends { id: string; displayName: string }>(
  items: T[],
  name: string,
): ResolveResult<T> {
  const normalized = name.trim().toLowerCase();
  const matches = items.filter((item) => item.displayName.trim().toLowerCase() === normalized);
  if (matches.length === 1) {
    return { ok: true, value: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Multiple matches found for "${name}". Use an id or key instead.`,
      matches: matches.map((item) => ({
        id: item.id,
        key: resolveMatchKey(item as { workloadKey?: unknown; assuranceKey?: unknown }),
        displayName: item.displayName,
      })),
    };
  }
  return { ok: false, error: `No match found for "${name}".` };
}

export function resolveResponsibilityForDevice(
  deviceId: string,
  selector: ResponsibilitySelector,
): ResolveResult<Workload> {
  const responsibilities = stateStore.getWorkloads(deviceId);
  if (selector.id) {
    const match = responsibilities.find((item) => item.id === selector.id);
    return match
      ? { ok: true, value: match }
      : { ok: false, error: `Responsibility ${selector.id} was not found on this device.` };
  }
  if (selector.key) {
    const normalized = selector.key.trim().toLowerCase();
    const match = responsibilities.find((item) => item.workloadKey.toLowerCase() === normalized);
    return match
      ? { ok: true, value: match }
      : { ok: false, error: `Responsibility ${selector.key} was not found on this device.` };
  }
  if (selector.name) {
    return resolveByName(responsibilities, selector.name);
  }
  return { ok: false, error: "Provide a responsibility id, key, or exact display name." };
}

export function resolveAssuranceForDevice(
  deviceId: string,
  selector: AssuranceSelector,
): ResolveResult<Assurance> {
  const assurances = stateStore.getAssurances(deviceId);
  if (selector.id) {
    const match = assurances.find((item) => item.id === selector.id);
    return match
      ? { ok: true, value: match }
      : { ok: false, error: `Assurance ${selector.id} was not found on this device.` };
  }
  if (selector.key) {
    const normalized = selector.key.trim().toLowerCase();
    const match = assurances.find((item) => item.assuranceKey.toLowerCase() === normalized);
    return match
      ? { ok: true, value: match }
      : { ok: false, error: `Assurance ${selector.key} was not found on this device.` };
  }
  if (selector.name) {
    return resolveByName(assurances, selector.name);
  }
  return { ok: false, error: "Provide an assurance id, key, or exact display name." };
}

export async function createResponsibility(args: {
  device: Device;
  displayName: string;
  workloadKey?: string;
  category?: WorkloadCategory;
  criticality?: Workload["criticality"];
  summary?: string;
  metadata?: ContractMutationMetadata;
}): Promise<Workload> {
  const now = nowIso();
  const existing = stateStore.getWorkloads(args.device.id);
  const keyBase = normalizeWorkloadKey(args.workloadKey ?? args.displayName);
  const workloadKey = uniqueWorkloadKey(existing, keyBase);
  const responsibility = stateStore.upsertWorkload({
    id: randomUUID(),
    deviceId: args.device.id,
    workloadKey,
    displayName: args.displayName,
    category: args.category ?? inferWorkloadCategoryFromText(`${args.displayName} ${workloadKey}`),
    criticality: args.criticality ?? "medium",
    source: sourceForMutation(args.metadata),
    summary: args.summary?.trim() || undefined,
    evidenceJson: {
      source: sourceForMutation(args.metadata),
      method: methodForMutation(args.metadata),
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    createdAt: now,
    updatedAt: now,
  });

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Added responsibility "${responsibility.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      workloadId: responsibility.id,
      workloadKey: responsibility.workloadKey,
      origin: args.metadata?.origin ?? null,
    },
  });

  return responsibility;
}

export async function updateResponsibility(args: {
  device: Device;
  responsibility: Workload;
  displayName?: string;
  category?: WorkloadCategory;
  criticality?: Workload["criticality"];
  summary?: string;
  clearSummary?: boolean;
  metadata?: ContractMutationMetadata;
}): Promise<Workload> {
  const now = nowIso();
  const updated = stateStore.upsertWorkload({
    ...args.responsibility,
    displayName: args.displayName?.trim() || args.responsibility.displayName,
    category: args.category ?? args.responsibility.category,
    criticality: args.criticality ?? args.responsibility.criticality,
    summary: args.clearSummary ? undefined : args.summary?.trim() || args.responsibility.summary,
    source: sourceForMutation(args.metadata),
    evidenceJson: {
      ...(args.responsibility.evidenceJson ?? {}),
      source: sourceForMutation(args.metadata),
      method: methodForMutation(args.metadata),
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    updatedAt: now,
  });

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Updated responsibility "${updated.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      workloadId: updated.id,
      workloadKey: updated.workloadKey,
      origin: args.metadata?.origin ?? null,
    },
  });

  return updated;
}

export async function deleteResponsibility(args: {
  device: Device;
  responsibility: Workload;
  metadata?: ContractMutationMetadata;
}): Promise<{ responsibility: Workload; deletedAssuranceCount: number }> {
  const deletedAssuranceCount = stateStore.getAssurancesForWorkload(args.responsibility.id).length;
  stateStore.deleteWorkload(args.responsibility.id);

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Deleted responsibility "${args.responsibility.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      workloadId: args.responsibility.id,
      workloadKey: args.responsibility.workloadKey,
      deletedAssuranceCount,
      origin: args.metadata?.origin ?? null,
    },
  });

  return {
    responsibility: args.responsibility,
    deletedAssuranceCount,
  };
}

export async function createAssurance(args: {
  device: Device;
  displayName: string;
  assuranceKey?: string;
  workloadId?: string;
  criticality?: Assurance["criticality"];
  desiredState?: Assurance["desiredState"];
  checkIntervalSec?: number;
  monitorType?: string;
  requiredProtocols?: string[];
  rationale?: string;
  metadata?: ContractMutationMetadata;
}): Promise<Assurance> {
  const now = nowIso();
  const existing = stateStore.getAssurances(args.device.id);
  const keyBase = normalizeAssuranceKey(args.assuranceKey ?? args.displayName);
  const assuranceKey = uniqueAssuranceKey(existing, keyBase);
  const requiredProtocols = Array.from(new Set((args.requiredProtocols ?? []).map((item) => item.trim()).filter(Boolean)));

  const assurance = stateStore.upsertAssurance({
    id: randomUUID(),
    deviceId: args.device.id,
    workloadId: args.workloadId,
    assuranceKey,
    displayName: args.displayName,
    criticality: args.criticality ?? "medium",
    desiredState: args.desiredState ?? "running",
    checkIntervalSec: args.checkIntervalSec ?? 120,
    monitorType: args.monitorType?.trim() || undefined,
    requiredProtocols,
    rationale: args.rationale?.trim() || undefined,
    configJson: {
      source: sourceForMutation(args.metadata),
      method: methodForMutation(args.metadata),
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    serviceKey: assuranceKey,
    policyJson: {
      requiredProtocols,
      monitorType: args.monitorType?.trim() || undefined,
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    createdAt: now,
    updatedAt: now,
  });

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Added assurance "${assurance.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      assuranceId: assurance.id,
      assuranceKey: assurance.assuranceKey,
      workloadId: assurance.workloadId,
      origin: args.metadata?.origin ?? null,
    },
  });

  return assurance;
}

export async function updateAssurance(args: {
  device: Device;
  assurance: Assurance;
  workloadId?: string;
  displayName?: string;
  criticality?: Assurance["criticality"];
  desiredState?: Assurance["desiredState"];
  checkIntervalSec?: number;
  monitorType?: string;
  clearMonitorType?: boolean;
  requiredProtocols?: string[];
  clearRequiredProtocols?: boolean;
  rationale?: string;
  clearRationale?: boolean;
  metadata?: ContractMutationMetadata;
}): Promise<Assurance> {
  const now = nowIso();
  const requiredProtocols = args.clearRequiredProtocols
    ? []
    : args.requiredProtocols
      ? Array.from(new Set(args.requiredProtocols.map((item) => item.trim()).filter(Boolean)))
      : args.assurance.requiredProtocols ?? [];
  const monitorType = args.clearMonitorType
    ? undefined
    : args.monitorType?.trim() || args.assurance.monitorType;
  const rationale = args.clearRationale
    ? undefined
    : args.rationale?.trim() || args.assurance.rationale;

  const assurance = stateStore.upsertAssurance({
    ...args.assurance,
    workloadId: args.workloadId ?? args.assurance.workloadId,
    displayName: args.displayName?.trim() || args.assurance.displayName,
    criticality: args.criticality ?? args.assurance.criticality,
    desiredState: args.desiredState ?? args.assurance.desiredState,
    checkIntervalSec: args.checkIntervalSec ?? args.assurance.checkIntervalSec,
    monitorType,
    requiredProtocols,
    rationale,
    configJson: {
      ...(args.assurance.configJson ?? {}),
      source: sourceForMutation(args.metadata),
      method: methodForMutation(args.metadata),
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    policyJson: {
      ...(args.assurance.policyJson ?? {}),
      requiredProtocols,
      monitorType,
      updatedAt: now,
      origin: args.metadata?.origin ?? null,
    },
    updatedAt: now,
  });

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Updated assurance "${assurance.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      assuranceId: assurance.id,
      assuranceKey: assurance.assuranceKey,
      workloadId: assurance.workloadId,
      origin: args.metadata?.origin ?? null,
    },
  });

  return assurance;
}

export async function deleteAssurance(args: {
  device: Device;
  assurance: Assurance;
  metadata?: ContractMutationMetadata;
}): Promise<Assurance> {
  stateStore.deleteAssurance(args.assurance.id);

  await updateAdoptionCounts(args.device.id);
  await stateStore.addAction({
    actor: actorForMutation(args.metadata),
    kind: "config",
    message: `Deleted assurance "${args.assurance.displayName}" for ${args.device.name}`,
    context: {
      deviceId: args.device.id,
      assuranceId: args.assurance.id,
      assuranceKey: args.assurance.assuranceKey,
      workloadId: args.assurance.workloadId,
      origin: args.metadata?.origin ?? null,
    },
  });

  return args.assurance;
}

export function summarizeDeviceContractForPrompt(
  deviceId: string,
  options?: {
    responsibilityLimit?: number;
    assuranceLimit?: number;
  },
): string {
  const responsibilities = stateStore.getWorkloads(deviceId);
  const assurances = stateStore.getAssurances(deviceId);
  const responsibilityLimit = options?.responsibilityLimit ?? 10;
  const assuranceLimit = options?.assuranceLimit ?? 12;
  const responsibilitiesById = new Map(responsibilities.map((item) => [item.id, item]));
  const responsibilityLines = responsibilities.slice(0, responsibilityLimit).map((item) => {
    const summary = compactText(item.summary);
    return `- id=${item.id} key=${item.workloadKey} name="${item.displayName}" category=${item.category} criticality=${item.criticality}${summary ? ` summary="${summary}"` : ""}`;
  });
  const assuranceLines = assurances.slice(0, assuranceLimit).map((item) => {
    const linked = item.workloadId ? responsibilitiesById.get(item.workloadId)?.displayName ?? item.workloadId : "unlinked";
    const protocols = (item.requiredProtocols ?? []).slice(0, 4).join(",");
    const rationale = compactText(item.rationale);
    return `- id=${item.id} key=${item.assuranceKey} name="${item.displayName}" responsibility="${linked}" state=${item.desiredState} interval=${item.checkIntervalSec}s criticality=${item.criticality}${item.monitorType ? ` monitor=${item.monitorType}` : ""}${protocols ? ` protocols=${protocols}` : ""}${rationale ? ` rationale="${rationale}"` : ""}`;
  });

  return [
    "Steward contract on this device:",
    `- responsibilities=${responsibilities.length}`,
    `- assurances=${assurances.length}`,
    "Committed responsibilities:",
    ...(responsibilityLines.length > 0 ? responsibilityLines : ["- none"]),
    ...(responsibilities.length > responsibilityLimit
      ? [`- ${responsibilities.length - responsibilityLimit} more responsibilities not shown`]
      : []),
    "Committed assurances:",
    ...(assuranceLines.length > 0 ? assuranceLines : ["- none"]),
    ...(assurances.length > assuranceLimit
      ? [`- ${assurances.length - assuranceLimit} more assurances not shown`]
      : []),
  ].join("\n");
}
