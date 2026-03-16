import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getAuditDb,
  getAuditDbPath,
  getDb,
  getDataDir as dbGetDataDir,
  getDbPath,
  recoverCorruptAuditDatabase,
  recoverCorruptDatabase,
} from "@/lib/state/db";
import {
  defaultAuthSettings,
  defaultSystemSettings,
  ensureDefaults,
} from "@/lib/state/defaults";
import { defaultRuntimeSettings } from "@/lib/state/runtime-defaults";
import {
  findDashboardWidgetGridPlacement,
  normalizeDashboardWidgetColumnSpan,
  normalizeDashboardWidgetRowSpan,
  resolveDashboardWidgetGridLayout,
} from "@/lib/dashboard-widget-grid";
import { normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import { normalizeWidgetDescription } from "@/lib/widgets/description";
import type {
  AccessMethod,
  AccessSurface,
  ActionLog,
  AdoptionQuestion,
  AdoptionRun,
  Assurance,
  AssuranceRun,
  AgentRunRecord,
  AuthSettings,
  ChatMessage,
  ChatSession,
  ControlPlaneHealth,
  ControlPlaneLeaseRecord,
  ControlPlaneQueueLane,
  CredentialAccessLog,
  DashboardWidgetInventoryEntry,
  DashboardWidgetPage,
  DashboardWidgetPageItem,
  DashboardWidgetPageItemRecord,
  DashboardWidgetPageRecord,
  DailyDigest,
  Device,
  DeviceAdapterBinding,
  DeviceBaseline,
  DeviceCredential,
  DeviceFinding,
  FindingOccurrence,
  DeviceProfileBinding,
  DeviceAutomation,
  DeviceAutomationRun,
  DeviceWidget,
  DeviceWidgetOperationRun,
  DeviceWidgetRuntimeState,
  DiscoveryObservation,
  DiscoveryObservationInput,
  GraphEdge,
  GraphNode,
  Incident,
  LocalToolApproval,
  LocalToolRecord,
  MaintenanceWindow,
  NotificationChannel,
  NotificationDelivery,
  OAuthState,
  PlaybookRun,
  PolicyRule,
  ProtocolSessionLease,
  ProtocolSessionMessage,
  ProtocolSessionRecord,
  ProviderConfig,
  Recommendation,
  RuntimeSettings,
  ScannerRunRecord,
  ServiceContract,
  SettingsHistoryEntry,
  StewardState,
  SystemSettings,
  Workload,
} from "@/lib/state/types";

const WEB_RESEARCH_PROVIDER_VALUES: RuntimeSettings["webResearchProvider"][] = [
  "brave_scrape",
  "duckduckgo_scrape",
  "brave_api",
  "serper",
  "serpapi",
];

const WEB_RESEARCH_FALLBACK_STRATEGY_VALUES: RuntimeSettings["webResearchFallbackStrategy"][] = [
  "prefer_non_key",
  "key_only",
  "selected_only",
];

const LOCAL_TOOL_APPROVAL_POLICY_VALUES: RuntimeSettings["localToolInstallPolicy"][] = [
  "require_approval",
  "allow_safe",
  "allow_all",
  "deny",
];

/* ---------- Row <-> Domain helpers ---------- */

function deviceFromRow(row: Record<string, unknown>): Device {
  const secondaryIps = row.secondaryIps ? JSON.parse(row.secondaryIps as string) as string[] : [];
  return {
    id: row.id as string,
    name: row.name as string,
    ip: row.ip as string,
    secondaryIps: secondaryIps.length > 0 ? secondaryIps : undefined,
    mac: (row.mac as string) ?? undefined,
    hostname: (row.hostname as string) ?? undefined,
    vendor: (row.vendor as string) ?? undefined,
    os: (row.os as string) ?? undefined,
    role: (row.role as string) ?? undefined,
    type: row.type as Device["type"],
    status: row.status as Device["status"],
    autonomyTier: row.autonomyTier as Device["autonomyTier"],
    tags: JSON.parse(row.tags as string) as string[],
    protocols: JSON.parse(row.protocols as string) as string[],
    services: JSON.parse(row.services as string) as Device["services"],
    firstSeenAt: row.firstSeenAt as string,
    lastSeenAt: row.lastSeenAt as string,
    lastChangedAt: row.lastChangedAt as string,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function baselineFromRow(row: Record<string, unknown>): DeviceBaseline {
  return {
    deviceId: row.deviceId as string,
    avgLatencyMs: row.avgLatencyMs as number,
    maxLatencyMs: row.maxLatencyMs as number,
    minLatencyMs: row.minLatencyMs as number,
    samples: row.samples as number,
    lastUpdatedAt: row.lastUpdatedAt as string,
  };
}

function incidentFromRow(row: Record<string, unknown>): Incident {
  return {
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    severity: row.severity as Incident["severity"],
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    status: row.status as Incident["status"],
    detectedAt: row.detectedAt as string,
    updatedAt: row.updatedAt as string,
    timeline: JSON.parse(row.timeline as string) as Incident["timeline"],
    diagnosis: (row.diagnosis as string) ?? undefined,
    remediationPlan: (row.remediationPlan as string) ?? undefined,
    autoRemediated: Boolean(row.autoRemediated),
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function recommendationFromRow(row: Record<string, unknown>): Recommendation {
  return {
    id: row.id as string,
    title: row.title as string,
    rationale: row.rationale as string,
    impact: row.impact as string,
    priority: row.priority as Recommendation["priority"],
    relatedDeviceIds: JSON.parse(row.relatedDeviceIds as string) as string[],
    createdAt: row.createdAt as string,
    dismissed: Boolean(row.dismissed),
  };
}

function actionFromRow(row: Record<string, unknown>): ActionLog {
  return {
    id: row.id as string,
    at: row.at as string,
    actor: row.actor as ActionLog["actor"],
    kind: row.kind as ActionLog["kind"],
    message: row.message as string,
    context: JSON.parse(row.context as string) as Record<string, unknown>,
  };
}

function graphNodeFromRow(row: Record<string, unknown>): GraphNode {
  return {
    id: row.id as string,
    type: row.type as GraphNode["type"],
    label: row.label as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function graphEdgeFromRow(row: Record<string, unknown>): GraphEdge {
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    type: row.type as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function providerConfigFromRow(row: Record<string, unknown>): ProviderConfig {
  const config: ProviderConfig = {
    provider: row.provider as ProviderConfig["provider"],
    enabled: Boolean(row.enabled),
    model: row.model as string,
  };
  if (row.apiKeyEnvVar) config.apiKeyEnvVar = row.apiKeyEnvVar as string;
  if (row.oauthTokenSecret) config.oauthTokenSecret = row.oauthTokenSecret as string;
  if (row.oauthClientIdEnvVar) config.oauthClientIdEnvVar = row.oauthClientIdEnvVar as string;
  if (row.oauthClientSecretEnvVar) config.oauthClientSecretEnvVar = row.oauthClientSecretEnvVar as string;
  if (row.oauthAuthUrl) config.oauthAuthUrl = row.oauthAuthUrl as string;
  if (row.oauthTokenUrl) config.oauthTokenUrl = row.oauthTokenUrl as string;
  if (row.oauthScopes) config.oauthScopes = JSON.parse(row.oauthScopes as string) as string[];
  if (row.baseUrl) config.baseUrl = row.baseUrl as string;
  if (row.extraHeaders) config.extraHeaders = JSON.parse(row.extraHeaders as string) as Record<string, string>;
  return config;
}

function oauthStateFromRow(row: Record<string, unknown>): OAuthState {
  return {
    id: row.id as string,
    provider: row.provider as OAuthState["provider"],
    redirectUri: row.redirectUri as string,
    codeVerifier: row.codeVerifier as string,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
  };
}

function agentRunFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: row.id as string,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string) ?? undefined,
    outcome: row.outcome as AgentRunRecord["outcome"],
    summary: row.summary as string,
    details: JSON.parse(row.details as string) as Record<string, unknown>,
  };
}

function scannerRunFromRow(row: Record<string, unknown>): ScannerRunRecord {
  return {
    id: row.id as string,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string) ?? undefined,
    outcome: row.outcome as ScannerRunRecord["outcome"],
    summary: row.summary as string,
    details: JSON.parse(row.details as string) as Record<string, unknown>,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall back to an empty object for malformed persisted JSON.
  }

  return {};
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function leaseHolderPid(holder: unknown): number | null {
  if (typeof holder !== "string") {
    return null;
  }

  const segments = holder.split(":");
  if (segments.length < 2) {
    return null;
  }

  const pid = Number(segments[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function runtimeLeaseFromRow(row: Record<string, unknown>): ControlPlaneLeaseRecord {
  return {
    name: String(row.name),
    holder: String(row.holder),
    expiresAt: String(row.expiresAt),
    updatedAt: String(row.updatedAt),
    metadataJson: parseJsonObject(row.metadataJson as string),
  };
}

function policyRuleFromRow(row: Record<string, unknown>): PolicyRule {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    actionClasses: JSON.parse(row.actionClasses as string) as PolicyRule["actionClasses"],
    autonomyTiers: JSON.parse(row.autonomyTiers as string) as PolicyRule["autonomyTiers"],
    environmentLabels: JSON.parse(row.environmentLabels as string) as PolicyRule["environmentLabels"],
    deviceTypes: JSON.parse(row.deviceTypes as string) as PolicyRule["deviceTypes"],
    decision: row.decision as PolicyRule["decision"],
    priority: row.priority as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function maintenanceWindowFromRow(row: Record<string, unknown>): MaintenanceWindow {
  return {
    id: row.id as string,
    name: row.name as string,
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    cronStart: row.cronStart as string,
    durationMinutes: row.durationMinutes as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
  };
}

function playbookRunFromRow(row: Record<string, unknown>): PlaybookRun {
  const policyEvaluationRaw = JSON.parse(row.policyEvaluation as string) as Partial<PlaybookRun["policyEvaluation"]>;
  const policyInputsRaw = (policyEvaluationRaw.inputs ?? {}) as Partial<PlaybookRun["policyEvaluation"]["inputs"]>;

  return {
    id: row.id as string,
    playbookId: row.playbookId as string,
    family: row.family as PlaybookRun["family"],
    name: row.name as string,
    deviceId: row.deviceId as string,
    incidentId: (row.incidentId as string) ?? undefined,
    actionClass: row.actionClass as PlaybookRun["actionClass"],
    status: row.status as PlaybookRun["status"],
    policyEvaluation: {
      decision: (policyEvaluationRaw.decision as PlaybookRun["policyEvaluation"]["decision"]) ?? "REQUIRE_APPROVAL",
      ruleId: policyEvaluationRaw.ruleId ?? null,
      reason: String(policyEvaluationRaw.reason ?? "Policy evaluation unavailable"),
      riskScore: Number.isFinite(Number(policyEvaluationRaw.riskScore))
        ? Math.max(0, Math.min(1, Number(policyEvaluationRaw.riskScore)))
        : 0.5,
      riskFactors: Array.isArray(policyEvaluationRaw.riskFactors)
        ? policyEvaluationRaw.riskFactors
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      evaluatedAt: String(policyEvaluationRaw.evaluatedAt ?? row.createdAt ?? new Date().toISOString()),
      inputs: {
        actionClass: (policyInputsRaw.actionClass as PlaybookRun["policyEvaluation"]["inputs"]["actionClass"])
          ?? (row.actionClass as PlaybookRun["actionClass"]),
        autonomyTier: (policyInputsRaw.autonomyTier as PlaybookRun["policyEvaluation"]["inputs"]["autonomyTier"]) ?? 1,
        environmentLabel: (policyInputsRaw.environmentLabel as PlaybookRun["policyEvaluation"]["inputs"]["environmentLabel"]) ?? "lab",
        inMaintenanceWindow: Boolean(policyInputsRaw.inMaintenanceWindow),
        deviceId: String(policyInputsRaw.deviceId ?? row.deviceId),
        blastRadius: (policyInputsRaw.blastRadius as PlaybookRun["policyEvaluation"]["inputs"]["blastRadius"]) ?? "single-device",
        criticality: (policyInputsRaw.criticality as PlaybookRun["policyEvaluation"]["inputs"]["criticality"]) ?? "medium",
        lane: (policyInputsRaw.lane as PlaybookRun["policyEvaluation"]["inputs"]["lane"]) ?? "A",
        recentFailures: Number(policyInputsRaw.recentFailures ?? 0),
        quarantineActive: Boolean(policyInputsRaw.quarantineActive),
      },
    },
    steps: JSON.parse(row.steps as string) as PlaybookRun["steps"],
    verificationSteps: JSON.parse(row.verificationSteps as string) as PlaybookRun["verificationSteps"],
    rollbackSteps: JSON.parse(row.rollbackSteps as string) as PlaybookRun["rollbackSteps"],
    evidence: JSON.parse(row.evidence as string) as PlaybookRun["evidence"],
    createdAt: row.createdAt as string,
    startedAt: (row.startedAt as string) ?? undefined,
    completedAt: (row.completedAt as string) ?? undefined,
    approvedBy: (row.approvedBy as string) ?? undefined,
    approvedAt: (row.approvedAt as string) ?? undefined,
    deniedBy: (row.deniedBy as string) ?? undefined,
    deniedAt: (row.deniedAt as string) ?? undefined,
    denialReason: (row.denialReason as string) ?? undefined,
    expiresAt: (row.expiresAt as string) ?? undefined,
    failureCount: row.failureCount as number,
  };
}

function dailyDigestFromRow(row: Record<string, unknown>): DailyDigest {
  const content = JSON.parse(row.content as string) as Omit<DailyDigest, "id" | "generatedAt" | "periodStart" | "periodEnd">;
  return {
    id: row.id as string,
    generatedAt: row.generatedAt as string,
    periodStart: row.periodStart as string,
    periodEnd: row.periodEnd as string,
    ...content,
  };
}

function discoveryObservationFromRow(row: Record<string, unknown>): DiscoveryObservation {
  return {
    id: row.id as string,
    ip: row.ip as string,
    deviceId: row.deviceId ? String(row.deviceId) : undefined,
    source: row.source as DiscoveryObservation["source"],
    evidenceType: row.evidenceType as DiscoveryObservation["evidenceType"],
    confidence: Number(row.confidence),
    observedAt: String(row.observedAt),
    expiresAt: String(row.expiresAt),
    details: JSON.parse(String(row.details ?? "{}")) as Record<string, unknown>,
  };
}

function adoptionRunFromRow(row: Record<string, unknown>): AdoptionRun {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    status: row.status as AdoptionRun["status"],
    stage: row.stage as AdoptionRun["stage"],
    profileJson: JSON.parse(String(row.profileJson ?? "{}")) as Record<string, unknown>,
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function adoptionQuestionFromRow(row: Record<string, unknown>): AdoptionQuestion {
  return {
    id: String(row.id),
    runId: String(row.runId),
    deviceId: String(row.deviceId),
    questionKey: String(row.questionKey),
    prompt: String(row.prompt),
    options: JSON.parse(String(row.optionsJson ?? "[]")) as AdoptionQuestion["options"],
    required: Boolean(row.required),
    answerJson: row.answerJson ? JSON.parse(String(row.answerJson)) as Record<string, unknown> : undefined,
    answeredAt: row.answeredAt ? String(row.answeredAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function notificationChannelFromRow(row: Record<string, unknown>): NotificationChannel {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as NotificationChannel["kind"],
    enabled: Boolean(row.enabled),
    target: String(row.target),
    eventKinds: JSON.parse(String(row.eventKinds ?? "[]")) as NotificationChannel["eventKinds"],
    minimumSeverity: row.minimumSeverity ? row.minimumSeverity as NotificationChannel["minimumSeverity"] : undefined,
    vaultSecretRef: row.vaultSecretRef ? String(row.vaultSecretRef) : undefined,
    configJson: JSON.parse(String(row.configJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function notificationDeliveryFromRow(row: Record<string, unknown>): NotificationDelivery {
  return {
    id: String(row.id),
    channelId: String(row.channelId),
    eventKind: row.eventKind as NotificationDelivery["eventKind"],
    eventRef: String(row.eventRef),
    summary: String(row.summary),
    payloadJson: JSON.parse(String(row.payloadJson ?? "{}")) as Record<string, unknown>,
    status: row.status as NotificationDelivery["status"],
    attempts: Number(row.attempts ?? 0),
    lastError: row.lastError ? String(row.lastError) : undefined,
    deliveredAt: row.deliveredAt ? String(row.deliveredAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceCredentialFromRow(row: Record<string, unknown>): DeviceCredential {
  const rawStatus = String(row.status ?? "provided").toLowerCase();
  const status: DeviceCredential["status"] = rawStatus === "pending"
    ? "pending"
    : rawStatus === "validated"
      ? "validated"
      : rawStatus === "invalid"
        ? "invalid"
        : "provided";
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    protocol: normalizeCredentialProtocol(String(row.protocol)),
    adapterId: row.adapterId ? String(row.adapterId) : undefined,
    vaultSecretRef: String(row.vaultSecretRef),
    accountLabel: row.accountLabel ? String(row.accountLabel) : undefined,
    scopeJson: JSON.parse(String(row.scopeJson ?? "{}")) as Record<string, unknown>,
    status,
    lastValidatedAt: row.lastValidatedAt ? String(row.lastValidatedAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function accessMethodFromRow(row: Record<string, unknown>): AccessMethod {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    key: String(row.key),
    kind: row.kind as AccessMethod["kind"],
    title: String(row.title),
    protocol: String(row.protocol),
    port: row.port === null || row.port === undefined ? undefined : Number(row.port),
    secure: Number(row.secure ?? 0) > 0,
    selected: Number(row.selected ?? 0) > 0,
    status: row.status as AccessMethod["status"],
    credentialProtocol: row.credentialProtocol ? String(row.credentialProtocol) : undefined,
    summary: row.summary ? String(row.summary) : undefined,
    metadataJson: JSON.parse(String(row.metadataJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceProfileBindingFromRow(row: Record<string, unknown>): DeviceProfileBinding {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    profileId: String(row.profileId),
    adapterId: row.adapterId ? String(row.adapterId) : undefined,
    name: String(row.name),
    kind: row.kind as DeviceProfileBinding["kind"],
    confidence: Number(row.confidence ?? 0),
    status: row.status as DeviceProfileBinding["status"],
    summary: String(row.summary ?? ""),
    requiredAccessMethods: JSON.parse(String(row.requiredAccessMethods ?? "[]")) as string[],
    requiredCredentialProtocols: JSON.parse(String(row.requiredCredentialProtocols ?? "[]")) as string[],
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    draftJson: JSON.parse(String(row.draftJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function accessSurfaceFromRow(row: Record<string, unknown>): AccessSurface {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    adapterId: String(row.adapterId),
    protocol: String(row.protocol),
    score: Number(row.score ?? 0),
    selected: Boolean(row.selected),
    reason: String(row.reason ?? ""),
    configJson: JSON.parse(String(row.configJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function workloadFromRow(row: Record<string, unknown>): Workload {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    workloadKey: String(row.workloadKey),
    displayName: String(row.displayName),
    category: row.category as Workload["category"],
    criticality: row.criticality as Workload["criticality"],
    source: row.source as Workload["source"],
    summary: row.summary ? String(row.summary) : undefined,
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function assuranceFromRow(row: Record<string, unknown>): Assurance {
  const configJson = JSON.parse(String(row.configJson ?? row.policyJson ?? "{}")) as Record<string, unknown>;
  const policyJson = JSON.parse(String(row.policyJson ?? row.configJson ?? "{}")) as Record<string, unknown>;
  const requiredProtocols = JSON.parse(String(row.requiredProtocols ?? "[]")) as string[];
  const assuranceKey = row.assuranceKey ? String(row.assuranceKey) : String(row.serviceKey ?? "");
  const serviceKey = row.serviceKey ? String(row.serviceKey) : assuranceKey;
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    workloadId: row.workloadId ? String(row.workloadId) : undefined,
    assuranceKey,
    displayName: String(row.displayName),
    criticality: row.criticality as Assurance["criticality"],
    desiredState: row.desiredState as Assurance["desiredState"],
    checkIntervalSec: Number(row.checkIntervalSec ?? 60),
    monitorType: row.monitorType ? String(row.monitorType) : undefined,
    requiredProtocols: Array.isArray(requiredProtocols) ? requiredProtocols : [],
    rationale: row.rationale ? String(row.rationale) : undefined,
    configJson,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    serviceKey,
    policyJson,
  };
}

function assuranceRunFromRow(row: Record<string, unknown>): AssuranceRun {
  return {
    id: String(row.id),
    assuranceId: String(row.assuranceId),
    deviceId: String(row.deviceId),
    workloadId: row.workloadId ? String(row.workloadId) : undefined,
    status: row.status as AssuranceRun["status"],
    summary: String(row.summary),
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    evaluatedAt: String(row.evaluatedAt),
  };
}

function localToolRecordFromRow(row: Record<string, unknown>): LocalToolRecord {
  return {
    id: String(row.id),
    manifest: JSON.parse(String(row.manifestJson ?? "{}")) as LocalToolRecord["manifest"],
    enabled: Number(row.enabled ?? 0) > 0,
    status: row.status as LocalToolRecord["status"],
    healthStatus: row.healthStatus as LocalToolRecord["healthStatus"],
    installDir: row.installDir ? String(row.installDir) : undefined,
    binPaths: JSON.parse(String(row.binPathsJson ?? "{}")) as Record<string, string>,
    installedVersion: row.installedVersion ? String(row.installedVersion) : undefined,
    lastInstalledAt: row.lastInstalledAt ? String(row.lastInstalledAt) : undefined,
    lastCheckedAt: row.lastCheckedAt ? String(row.lastCheckedAt) : undefined,
    lastRunAt: row.lastRunAt ? String(row.lastRunAt) : undefined,
    approvedAt: row.approvedAt ? String(row.approvedAt) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function localToolApprovalFromRow(row: Record<string, unknown>): LocalToolApproval {
  return {
    id: String(row.id),
    toolId: String(row.toolId),
    action: row.action as LocalToolApproval["action"],
    status: row.status as LocalToolApproval["status"],
    requestedBy: row.requestedBy as LocalToolApproval["requestedBy"],
    requestedAt: String(row.requestedAt),
    expiresAt: row.expiresAt ? String(row.expiresAt) : undefined,
    reason: String(row.reason ?? ""),
    requestJson: JSON.parse(String(row.requestJson ?? "{}")) as Record<string, unknown>,
    approvedBy: row.approvedBy ? String(row.approvedBy) : undefined,
    approvedAt: row.approvedAt ? String(row.approvedAt) : undefined,
    deniedBy: row.deniedBy ? String(row.deniedBy) : undefined,
    deniedAt: row.deniedAt ? String(row.deniedAt) : undefined,
    denialReason: row.denialReason ? String(row.denialReason) : undefined,
    decisionJson: JSON.parse(String(row.decisionJson ?? "{}")) as Record<string, unknown>,
  };
}

function protocolSessionRecordFromRow(row: Record<string, unknown>): ProtocolSessionRecord {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    protocol: row.protocol as ProtocolSessionRecord["protocol"],
    adapterId: row.adapterId ? String(row.adapterId) : undefined,
    desiredState: row.desiredState as ProtocolSessionRecord["desiredState"],
    status: row.status as ProtocolSessionRecord["status"],
    arbitrationMode: row.arbitrationMode as ProtocolSessionRecord["arbitrationMode"],
    singleConnectionHint: Number(row.singleConnectionHint ?? 0) > 0,
    keepaliveAllowed: Number(row.keepaliveAllowed ?? 0) > 0,
    summary: row.summary ? String(row.summary) : undefined,
    configJson: JSON.parse(String(row.configJson ?? "{}")) as Record<string, unknown>,
    activeLeaseId: row.activeLeaseId ? String(row.activeLeaseId) : undefined,
    lastConnectedAt: row.lastConnectedAt ? String(row.lastConnectedAt) : undefined,
    lastDisconnectedAt: row.lastDisconnectedAt ? String(row.lastDisconnectedAt) : undefined,
    lastMessageAt: row.lastMessageAt ? String(row.lastMessageAt) : undefined,
    lastError: row.lastError ? String(row.lastError) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function protocolSessionLeaseFromRow(row: Record<string, unknown>): ProtocolSessionLease {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    holder: String(row.holder),
    purpose: String(row.purpose),
    mode: row.mode as ProtocolSessionLease["mode"],
    status: row.status as ProtocolSessionLease["status"],
    exclusive: Number(row.exclusive ?? 0) > 0,
    requestedAt: String(row.requestedAt),
    grantedAt: row.grantedAt ? String(row.grantedAt) : undefined,
    releasedAt: row.releasedAt ? String(row.releasedAt) : undefined,
    expiresAt: String(row.expiresAt),
    metadataJson: JSON.parse(String(row.metadataJson ?? "{}")) as Record<string, unknown>,
  };
}

function protocolSessionMessageFromRow(row: Record<string, unknown>): ProtocolSessionMessage {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    deviceId: String(row.deviceId),
    direction: row.direction as ProtocolSessionMessage["direction"],
    channel: String(row.channel),
    payload: String(row.payload ?? ""),
    metadataJson: JSON.parse(String(row.metadataJson ?? "{}")) as Record<string, unknown>,
    observedAt: String(row.observedAt),
  };
}

function slugifyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function inferWorkloadCategoryFromText(value: string): Workload["category"] {
  const text = value.toLowerCase();
  if (/\b(mysql|postgres|redis|mongo|database|db)\b/.test(text)) return "data";
  if (/\b(nginx|apache|proxy|traefik|haproxy|web|api)\b/.test(text)) return "application";
  if (/\b(dns|dhcp|gateway|router|switch|firewall|vpn)\b/.test(text)) return "network";
  if (/\b(storage|nas|nfs|smb|cifs|minio)\b/.test(text)) return "storage";
  if (/\b(backup|cron|queue|scheduler|worker|replication|sync)\b/.test(text)) return "background";
  if (/\b(metrics|monitor|telemetry|logging|prometheus|grafana)\b/.test(text)) return "telemetry";
  return "unknown";
}

function deviceFindingFromRow(row: Record<string, unknown>): DeviceFinding {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    dedupeKey: String(row.dedupeKey),
    findingType: String(row.findingType),
    severity: row.severity as DeviceFinding["severity"],
    title: String(row.title),
    summary: String(row.summary),
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    status: row.status as DeviceFinding["status"],
    firstSeenAt: String(row.firstSeenAt),
    lastSeenAt: String(row.lastSeenAt),
  };
}

function findingOccurrenceFromRow(row: Record<string, unknown>): FindingOccurrence {
  return {
    id: String(row.id),
    findingId: row.findingId ? String(row.findingId) : undefined,
    deviceId: String(row.deviceId),
    dedupeKey: String(row.dedupeKey),
    findingType: String(row.findingType),
    severity: row.severity as FindingOccurrence["severity"],
    status: row.status as FindingOccurrence["status"],
    summary: String(row.summary),
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    source: String(row.source),
    observedAt: String(row.observedAt),
    metadataJson: JSON.parse(String(row.metadataJson ?? "{}")) as Record<string, unknown>,
  };
}

function deviceWidgetFromRow(row: Record<string, unknown>): DeviceWidget {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    status: row.status as DeviceWidget["status"],
    html: String(row.html ?? ""),
    css: String(row.css ?? ""),
    js: String(row.js ?? ""),
    capabilities: JSON.parse(String(row.capabilitiesJson ?? "[]")) as DeviceWidget["capabilities"],
    controls: JSON.parse(String(row.controlsJson ?? "[]")) as DeviceWidget["controls"],
    sourcePrompt: row.sourcePrompt ? String(row.sourcePrompt) : undefined,
    createdBy: row.createdBy as DeviceWidget["createdBy"],
    revision: Number(row.revision ?? 1),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceWidgetRuntimeStateFromRow(row: Record<string, unknown>): DeviceWidgetRuntimeState {
  return {
    widgetId: String(row.widgetId),
    deviceId: String(row.deviceId),
    stateJson: JSON.parse(String(row.stateJson ?? "{}")) as Record<string, unknown>,
    updatedAt: String(row.updatedAt),
  };
}

function dashboardWidgetPageRecordFromRow(row: Record<string, unknown>): DashboardWidgetPageRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function dashboardWidgetInventoryEntryFromRow(row: Record<string, unknown>): DashboardWidgetInventoryEntry {
  return {
    widgetId: String(row.widgetId),
    deviceId: String(row.deviceId),
    deviceName: String(row.deviceName ?? row.deviceHostname ?? row.deviceId),
    deviceIp: String(row.deviceIp ?? ""),
    deviceStatus: row.deviceStatus as DashboardWidgetInventoryEntry["deviceStatus"],
    widgetSlug: String(row.widgetSlug),
    widgetName: String(row.widgetName),
    widgetDescription: row.widgetDescription ? String(row.widgetDescription) : undefined,
    widgetStatus: row.widgetStatus as DashboardWidgetInventoryEntry["widgetStatus"],
    widgetRevision: Number(row.widgetRevision ?? 1),
    capabilities: JSON.parse(String(row.capabilitiesJson ?? "[]")) as DashboardWidgetInventoryEntry["capabilities"],
    updatedAt: String(row.widgetUpdatedAt),
  };
}

function dashboardWidgetPageItemFromRow(row: Record<string, unknown>): DashboardWidgetPageItem {
  const item: DashboardWidgetPageItemRecord = {
    id: String(row.id),
    pageId: String(row.pageId),
    widgetId: String(row.widgetId),
    title: row.title ? String(row.title) : undefined,
    columnStart: Number(row.columnStart ?? 1),
    columnSpan: Number(row.columnSpan ?? 6),
    rowStart: Number(row.rowStart ?? 1),
    rowSpan: Number(row.rowSpan ?? 4),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };

  return {
    ...item,
    widget: dashboardWidgetInventoryEntryFromRow(row),
  };
}

function dashboardWidgetPageItemRecordFromRow(row: Record<string, unknown>): DashboardWidgetPageItemRecord {
  return {
    id: String(row.id),
    pageId: String(row.pageId),
    widgetId: String(row.widgetId),
    title: row.title ? String(row.title) : undefined,
    columnStart: Number(row.columnStart ?? 1),
    columnSpan: Number(row.columnSpan ?? 6),
    rowStart: Number(row.rowStart ?? 1),
    rowSpan: Number(row.rowSpan ?? 4),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceWidgetOperationRunFromRow(row: Record<string, unknown>): DeviceWidgetOperationRun {
  return {
    id: String(row.id),
    widgetId: String(row.widgetId),
    deviceId: String(row.deviceId),
    widgetRevision: Number(row.widgetRevision ?? 1),
    operationKind: row.operationKind as DeviceWidgetOperationRun["operationKind"],
    operationMode: row.operationMode as DeviceWidgetOperationRun["operationMode"],
    brokerProtocol: row.brokerProtocol ? row.brokerProtocol as DeviceWidgetOperationRun["brokerProtocol"] : undefined,
    status: row.status as DeviceWidgetOperationRun["status"],
    phase: row.phase as DeviceWidgetOperationRun["phase"],
    proof: row.proof as DeviceWidgetOperationRun["proof"],
    approvalRequired: Number(row.approvalRequired ?? 0) > 0,
    policyDecision: row.policyDecision as DeviceWidgetOperationRun["policyDecision"],
    policyReason: String(row.policyReason ?? ""),
    approved: Number(row.approved ?? 0) > 0,
    idempotencyKey: String(row.idempotencyKey ?? ""),
    summary: String(row.summary ?? ""),
    output: String(row.output ?? ""),
    operationJson: JSON.parse(String(row.operationJson ?? "{}")) as Record<string, unknown>,
    detailsJson: JSON.parse(String(row.detailsJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
  };
}

function deviceAutomationFromRow(row: Record<string, unknown>): DeviceAutomation {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    targetKind: row.targetKind as DeviceAutomation["targetKind"],
    widgetId: String(row.widgetId),
    controlId: String(row.controlId),
    targetJson: JSON.parse(String(row.targetJson ?? "{}")) as Record<string, unknown>,
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    enabled: Number(row.enabled ?? 0) > 0,
    scheduleKind: row.scheduleKind as DeviceAutomation["scheduleKind"],
    intervalMinutes: row.intervalMinutes === null || typeof row.intervalMinutes === "undefined"
      ? undefined
      : Number(row.intervalMinutes),
    hourLocal: row.hourLocal === null || typeof row.hourLocal === "undefined"
      ? undefined
      : Number(row.hourLocal),
    minuteLocal: row.minuteLocal === null || typeof row.minuteLocal === "undefined"
      ? undefined
      : Number(row.minuteLocal),
    inputJson: JSON.parse(String(row.inputJson ?? "{}")) as Record<string, unknown>,
    lastRunAt: row.lastRunAt ? String(row.lastRunAt) : undefined,
    nextRunAt: row.nextRunAt ? String(row.nextRunAt) : undefined,
    lastRunStatus: row.lastRunStatus ? row.lastRunStatus as DeviceAutomation["lastRunStatus"] : undefined,
    lastRunSummary: row.lastRunSummary ? String(row.lastRunSummary) : undefined,
    createdBy: row.createdBy as DeviceAutomation["createdBy"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceAutomationRunFromRow(row: Record<string, unknown>): DeviceAutomationRun {
  return {
    id: String(row.id),
    automationId: String(row.automationId),
    deviceId: String(row.deviceId),
    widgetId: String(row.widgetId),
    controlId: String(row.controlId),
    status: row.status as DeviceAutomationRun["status"],
    summary: String(row.summary ?? ""),
    resultJson: JSON.parse(String(row.resultJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    completedAt: row.completedAt ? String(row.completedAt) : undefined,
  };
}

function settingsHistoryFromRow<T = Record<string, unknown>>(row: Record<string, unknown>): SettingsHistoryEntry<T> {
  return {
    id: String(row.id),
    domain: row.domain as SettingsHistoryEntry<T>["domain"],
    version: Number(row.version),
    effectiveFrom: String(row.effectiveFrom),
    payload: JSON.parse(String(row.payload ?? "{}")) as T,
    actor: row.actor as SettingsHistoryEntry<T>["actor"],
    createdAt: String(row.createdAt),
  };
}

/* ---------- StateStore ---------- */

class StateStore {
  private initialized = false;

  private normalizeLegacyCredentialProtocols(db: Database.Database): void {
    db.prepare(`
      UPDATE device_credentials
      SET protocol = 'winrm'
      WHERE lower(protocol) = 'windows'
    `).run();
    db.prepare(`
      UPDATE device_credentials
      SET status = CASE
        WHEN lower(status) = 'pending' THEN 'pending'
        WHEN lower(status) = 'validated' THEN 'validated'
        WHEN lower(status) = 'invalid' THEN 'invalid'
        ELSE 'provided'
      END
    `).run();
  }

  private ensureInit(): void {
    if (this.initialized) return;
    const db = getDb();
    ensureDefaults(db);
    this.normalizeLegacyCredentialProtocols(db);
    const auditDb = getAuditDb();
    const row = auditDb.prepare("SELECT COUNT(*) as cnt FROM audit_events").get() as { cnt: number };
    if (row.cnt === 0) {
      const init = {
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: "steward",
        kind: "config",
        message: "Steward audit ledger initialized",
        context: "{}",
      };
      auditDb.prepare(`
        INSERT INTO audit_events (id, at, actor, kind, message, context, idempotencyKey, createdAt)
        VALUES (@id, @at, @actor, @kind, @message, @context, @idempotencyKey, @createdAt)
      `).run({
        ...init,
        idempotencyKey: init.id,
        createdAt: init.at,
      });
    }
    this.initialized = true;
  }

  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => {
      this.ensureInit();
      return operation(getDb());
    };

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }

      this.initialized = false;
      return run();
    }
  }

  private withAuditDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => operation(getAuditDb());

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptAuditDatabase(error, context)) {
        throw error;
      }
      return run();
    }
  }

  private readRecentAuditEvents(limit = 2_000): ActionLog[] {
    return this.withAuditDbRecovery("StateStore.readRecentAuditEvents", (auditDb) => {
      const rows = auditDb.prepare(`
        SELECT id, at, actor, kind, message, context
        FROM audit_events
        ORDER BY at DESC, id DESC
        LIMIT ?
      `).all(limit) as Record<string, unknown>[];
      return rows.map(actionFromRow);
    });
  }

  private getVersion(db: Database.Database): number {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  }

  private getInitializedAt(db: Database.Database): string {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'initializedAt'").get() as { value: string } | undefined;
    return row?.value ?? new Date().toISOString();
  }

  private isValidTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }

  private coerceRuntimeSettings(raw: Partial<Record<keyof RuntimeSettings, unknown>>): RuntimeSettings {
    const defaults = defaultRuntimeSettings();
    const legacyAgentIntervalMs = (raw as Record<string, unknown>).agentIntervalMs;
    const asPositiveInt = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };
    const asBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };
    const asStringArray = (value: unknown, fallback: string[]): string[] => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item));
      }
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item));
          }
        } catch {
          return fallback;
        }
      }
      return fallback;
    };

    return {
      scannerIntervalMs: asPositiveInt(raw.scannerIntervalMs ?? legacyAgentIntervalMs, defaults.scannerIntervalMs),
      agentWakeIntervalMs: asPositiveInt(raw.agentWakeIntervalMs, defaults.agentWakeIntervalMs),
      deepScanIntervalMs: asPositiveInt(raw.deepScanIntervalMs, defaults.deepScanIntervalMs),
      incrementalActiveTargets: asPositiveInt(raw.incrementalActiveTargets, defaults.incrementalActiveTargets),
      deepActiveTargets: asPositiveInt(raw.deepActiveTargets, defaults.deepActiveTargets),
      incrementalPortScanHosts: asPositiveInt(raw.incrementalPortScanHosts, defaults.incrementalPortScanHosts),
      deepPortScanHosts: asPositiveInt(raw.deepPortScanHosts, defaults.deepPortScanHosts),
      llmDiscoveryLimit: asPositiveInt(raw.llmDiscoveryLimit, defaults.llmDiscoveryLimit),
      incrementalFingerprintTargets: Math.max(
        defaults.incrementalFingerprintTargets,
        asPositiveInt(raw.incrementalFingerprintTargets, defaults.incrementalFingerprintTargets),
      ),
      deepFingerprintTargets: Math.max(
        defaults.deepFingerprintTargets,
        asPositiveInt(raw.deepFingerprintTargets, defaults.deepFingerprintTargets),
      ),
      enableMdnsDiscovery: asBool(raw.enableMdnsDiscovery, defaults.enableMdnsDiscovery),
      enableSsdpDiscovery: asBool(raw.enableSsdpDiscovery, defaults.enableSsdpDiscovery),
      enableSnmpProbe: asBool(raw.enableSnmpProbe, defaults.enableSnmpProbe),
      enableAdvancedNmapFingerprint: asBool(raw.enableAdvancedNmapFingerprint, defaults.enableAdvancedNmapFingerprint),
      nmapFingerprintTimeoutMs: asPositiveInt(raw.nmapFingerprintTimeoutMs, defaults.nmapFingerprintTimeoutMs),
      incrementalNmapTargets: Math.max(1, asPositiveInt(raw.incrementalNmapTargets, defaults.incrementalNmapTargets)),
      deepNmapTargets: Math.max(
        1,
        asPositiveInt(raw.deepNmapTargets, defaults.deepNmapTargets),
      ),
      enablePacketIntel: asBool(raw.enablePacketIntel, defaults.enablePacketIntel),
      packetIntelDurationSec: Math.max(
        1,
        asPositiveInt(raw.packetIntelDurationSec, defaults.packetIntelDurationSec),
      ),
      packetIntelMaxPackets: Math.max(
        100,
        asPositiveInt(raw.packetIntelMaxPackets, defaults.packetIntelMaxPackets),
      ),
      packetIntelTopTalkers: Math.max(
        1,
        asPositiveInt(raw.packetIntelTopTalkers, defaults.packetIntelTopTalkers),
      ),
      enableBrowserObservation: asBool(raw.enableBrowserObservation, defaults.enableBrowserObservation),
      browserObservationTimeoutMs: asPositiveInt(
        raw.browserObservationTimeoutMs,
        defaults.browserObservationTimeoutMs,
      ),
      incrementalBrowserObservationTargets: Math.max(
        1,
        asPositiveInt(
          raw.incrementalBrowserObservationTargets,
          defaults.incrementalBrowserObservationTargets,
        ),
      ),
      deepBrowserObservationTargets: Math.max(
        1,
        asPositiveInt(raw.deepBrowserObservationTargets, defaults.deepBrowserObservationTargets),
      ),
      browserObservationCaptureScreenshots: asBool(
        raw.browserObservationCaptureScreenshots,
        defaults.browserObservationCaptureScreenshots,
      ),
      enableWebResearch: asBool(raw.enableWebResearch, defaults.enableWebResearch),
      webResearchProvider: WEB_RESEARCH_PROVIDER_VALUES.includes(raw.webResearchProvider as RuntimeSettings["webResearchProvider"])
        ? raw.webResearchProvider as RuntimeSettings["webResearchProvider"]
        : defaults.webResearchProvider,
      webResearchFallbackStrategy: WEB_RESEARCH_FALLBACK_STRATEGY_VALUES.includes(
        raw.webResearchFallbackStrategy as RuntimeSettings["webResearchFallbackStrategy"],
      )
        ? raw.webResearchFallbackStrategy as RuntimeSettings["webResearchFallbackStrategy"]
        : defaults.webResearchFallbackStrategy,
      webResearchTimeoutMs: asPositiveInt(raw.webResearchTimeoutMs, defaults.webResearchTimeoutMs),
      webResearchMaxResults: Math.max(
        1,
        asPositiveInt(raw.webResearchMaxResults, defaults.webResearchMaxResults),
      ),
      webResearchDeepReadPages: (() => {
        const parsed = Number(raw.webResearchDeepReadPages);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return Math.floor(parsed);
        }
        return defaults.webResearchDeepReadPages;
      })(),
      enableDhcpLeaseIntel: asBool(raw.enableDhcpLeaseIntel, defaults.enableDhcpLeaseIntel),
      dhcpLeaseCommandTimeoutMs: asPositiveInt(
        raw.dhcpLeaseCommandTimeoutMs,
        defaults.dhcpLeaseCommandTimeoutMs,
      ),
      ouiUpdateIntervalMs: asPositiveInt(raw.ouiUpdateIntervalMs, defaults.ouiUpdateIntervalMs),
      laneBEnabled: asBool(raw.laneBEnabled, defaults.laneBEnabled),
      laneBAllowedEnvironments: asStringArray(
        raw.laneBAllowedEnvironments,
        defaults.laneBAllowedEnvironments,
      ) as RuntimeSettings["laneBAllowedEnvironments"],
      laneBAllowedFamilies: asStringArray(raw.laneBAllowedFamilies, defaults.laneBAllowedFamilies),
      laneCMutationsInLab: asBool(raw.laneCMutationsInLab, defaults.laneCMutationsInLab),
      laneCMutationsInProd: asBool(raw.laneCMutationsInProd, defaults.laneCMutationsInProd),
      mutationRequireDryRunWhenSupported: asBool(
        raw.mutationRequireDryRunWhenSupported,
        defaults.mutationRequireDryRunWhenSupported,
      ),
      approvalTtlClassBMs: asPositiveInt(raw.approvalTtlClassBMs, defaults.approvalTtlClassBMs),
      approvalTtlClassCMs: asPositiveInt(raw.approvalTtlClassCMs, defaults.approvalTtlClassCMs),
      approvalTtlClassDMs: asPositiveInt(raw.approvalTtlClassDMs, defaults.approvalTtlClassDMs),
      quarantineThresholdCount: asPositiveInt(raw.quarantineThresholdCount, defaults.quarantineThresholdCount),
      quarantineThresholdWindowMs: asPositiveInt(
        raw.quarantineThresholdWindowMs,
        defaults.quarantineThresholdWindowMs,
      ),
      availabilityScannerAlertsEnabled: asBool(
        raw.availabilityScannerAlertsEnabled,
        defaults.availabilityScannerAlertsEnabled,
      ),
      securityScannerAlertsEnabled: asBool(
        raw.securityScannerAlertsEnabled,
        defaults.securityScannerAlertsEnabled,
      ),
      serviceContractScannerAlertsEnabled: asBool(
        raw.serviceContractScannerAlertsEnabled,
        defaults.serviceContractScannerAlertsEnabled,
      ),
      ignoredIncidentTypes: Array.from(
        new Set(
          asStringArray(raw.ignoredIncidentTypes, defaults.ignoredIncidentTypes)
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      ),
      localToolInstallPolicy: LOCAL_TOOL_APPROVAL_POLICY_VALUES.includes(
        raw.localToolInstallPolicy as RuntimeSettings["localToolInstallPolicy"],
      )
        ? raw.localToolInstallPolicy as RuntimeSettings["localToolInstallPolicy"]
        : defaults.localToolInstallPolicy,
      localToolExecutionPolicy: LOCAL_TOOL_APPROVAL_POLICY_VALUES.includes(
        raw.localToolExecutionPolicy as RuntimeSettings["localToolExecutionPolicy"],
      )
        ? raw.localToolExecutionPolicy as RuntimeSettings["localToolExecutionPolicy"]
        : defaults.localToolExecutionPolicy,
      localToolApprovalTtlMs: asPositiveInt(raw.localToolApprovalTtlMs, defaults.localToolApprovalTtlMs),
      localToolHealthCheckIntervalMs: asPositiveInt(
        raw.localToolHealthCheckIntervalMs,
        defaults.localToolHealthCheckIntervalMs,
      ),
      localToolAutoInstallBuiltins: asBool(raw.localToolAutoInstallBuiltins, defaults.localToolAutoInstallBuiltins),
      protocolSessionSweepIntervalMs: asPositiveInt(
        raw.protocolSessionSweepIntervalMs,
        defaults.protocolSessionSweepIntervalMs,
      ),
      protocolSessionDefaultLeaseTtlMs: asPositiveInt(
        raw.protocolSessionDefaultLeaseTtlMs,
        defaults.protocolSessionDefaultLeaseTtlMs,
      ),
      protocolSessionMaxLeaseTtlMs: asPositiveInt(
        raw.protocolSessionMaxLeaseTtlMs,
        defaults.protocolSessionMaxLeaseTtlMs,
      ),
      protocolSessionMessageRetentionLimit: Math.max(
        10,
        asPositiveInt(raw.protocolSessionMessageRetentionLimit, defaults.protocolSessionMessageRetentionLimit),
      ),
      protocolSessionReconnectBaseMs: asPositiveInt(
        raw.protocolSessionReconnectBaseMs,
        defaults.protocolSessionReconnectBaseMs,
      ),
      protocolSessionReconnectMaxMs: asPositiveInt(
        raw.protocolSessionReconnectMaxMs,
        defaults.protocolSessionReconnectMaxMs,
      ),
    };
  }

  private coerceSystemSettings(raw: Partial<Record<keyof SystemSettings, unknown>>): SystemSettings {
    const defaults = defaultSystemSettings();
    const parseBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };
    const parseBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };

    const timezoneCandidate =
      typeof raw.timezone === "string" && raw.timezone.trim().length > 0
        ? raw.timezone.trim()
        : defaults.timezone;
    const timezone = this.isValidTimezone(timezoneCandidate) ? timezoneCandidate : defaults.timezone;

    const nodeIdentity =
      typeof raw.nodeIdentity === "string" && raw.nodeIdentity.trim().length > 0
        ? raw.nodeIdentity.trim()
        : defaults.nodeIdentity;

    const upgradeChannel = raw.upgradeChannel === "preview" ? "preview" : "stable";

    return {
      nodeIdentity,
      timezone,
      digestScheduleEnabled: parseBool(raw.digestScheduleEnabled, defaults.digestScheduleEnabled),
      digestHourLocal: parseBoundedInt(raw.digestHourLocal, defaults.digestHourLocal, 0, 23),
      digestMinuteLocal: parseBoundedInt(raw.digestMinuteLocal, defaults.digestMinuteLocal, 0, 59),
      upgradeChannel,
    };
  }

  private coerceAuthSettings(raw: Partial<Record<keyof AuthSettings, unknown>>): AuthSettings {
    const defaults = defaultAuthSettings();

    const parseBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };

    const parseString = (value: unknown, fallback: string): string => {
      return typeof value === "string" ? value : fallback;
    };

    const parsePositiveInt = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
      return Math.floor(parsed);
    };

    const parseMode = (value: unknown): AuthSettings["mode"] => {
      if (value === "open" || value === "token" || value === "session" || value === "hybrid") {
        return value;
      }
      return defaults.mode;
    };

    const parseRole = (value: unknown, fallback: AuthSettings["oidc"]["defaultRole"]): AuthSettings["oidc"]["defaultRole"] => {
      if (
        value === "Owner"
        || value === "Admin"
        || value === "Operator"
        || value === "Auditor"
        || value === "ReadOnly"
      ) {
        return value;
      }
      return fallback;
    };

    const oidcRaw = (raw.oidc && typeof raw.oidc === "object")
      ? raw.oidc as Partial<AuthSettings["oidc"]>
      : {};
    const ldapRaw = (raw.ldap && typeof raw.ldap === "object")
      ? raw.ldap as Partial<AuthSettings["ldap"]>
      : {};

    return {
      apiTokenEnabled: parseBool(raw.apiTokenEnabled, defaults.apiTokenEnabled),
      mode: parseMode(raw.mode),
      sessionTtlHours: Math.min(24 * 30, parsePositiveInt(raw.sessionTtlHours, defaults.sessionTtlHours)),
      oidc: {
        enabled: parseBool(oidcRaw.enabled, defaults.oidc.enabled),
        issuer: parseString(oidcRaw.issuer, defaults.oidc.issuer),
        clientId: parseString(oidcRaw.clientId, defaults.oidc.clientId),
        scopes: parseString(oidcRaw.scopes, defaults.oidc.scopes),
        autoProvision: parseBool(oidcRaw.autoProvision, defaults.oidc.autoProvision),
        defaultRole: parseRole(oidcRaw.defaultRole, defaults.oidc.defaultRole),
        clientSecretConfigured: parseBool(oidcRaw.clientSecretConfigured, defaults.oidc.clientSecretConfigured),
      },
      ldap: {
        enabled: parseBool(ldapRaw.enabled, defaults.ldap.enabled),
        url: parseString(ldapRaw.url, defaults.ldap.url),
        baseDn: parseString(ldapRaw.baseDn, defaults.ldap.baseDn),
        bindDn: parseString(ldapRaw.bindDn, defaults.ldap.bindDn),
        userFilter: parseString(ldapRaw.userFilter, defaults.ldap.userFilter),
        uidAttribute: parseString(ldapRaw.uidAttribute, defaults.ldap.uidAttribute),
        autoProvision: parseBool(ldapRaw.autoProvision, defaults.ldap.autoProvision),
        defaultRole: parseRole(ldapRaw.defaultRole, defaults.ldap.defaultRole),
        bindPasswordConfigured: parseBool(
          ldapRaw.bindPasswordConfigured,
          defaults.ldap.bindPasswordConfigured,
        ),
      },
    };
  }

  private readSettingFromMetadata(db: Database.Database, key: string): string | undefined {
    const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private getLatestSettingsHistoryEntry<T = Record<string, unknown>>(
    db: Database.Database,
    domain: SettingsHistoryEntry<T>["domain"],
    asOf?: string,
  ): SettingsHistoryEntry<T> | null {
    const target = asOf ?? new Date().toISOString();
    const row = db.prepare(`
      SELECT id, domain, version, effectiveFrom, payload, actor, createdAt
      FROM settings_history
      WHERE domain = ?
        AND effectiveFrom <= ?
      ORDER BY effectiveFrom DESC, version DESC
      LIMIT 1
    `).get(domain, target) as Record<string, unknown> | undefined;
    return row ? settingsHistoryFromRow<T>(row) : null;
  }

  private appendSettingsHistory<T extends Record<string, unknown>>(
    db: Database.Database,
    domain: SettingsHistoryEntry<T>["domain"],
    payload: T,
    actor: SettingsHistoryEntry["actor"] = "user",
    effectiveFrom?: string,
  ): SettingsHistoryEntry<T> {
    const createdAt = new Date().toISOString();
    const nextVersionRow = db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 as nextVersion FROM settings_history WHERE domain = ?",
    ).get(domain) as { nextVersion: number };

    const entry: SettingsHistoryEntry<T> = {
      id: randomUUID(),
      domain,
      version: Number(nextVersionRow.nextVersion),
      effectiveFrom: effectiveFrom ?? createdAt,
      payload,
      actor,
      createdAt,
    };

    db.prepare(`
      INSERT INTO settings_history (id, domain, version, effectiveFrom, payload, actor, createdAt)
      VALUES (@id, @domain, @version, @effectiveFrom, @payload, @actor, @createdAt)
    `).run({
      id: entry.id,
      domain: entry.domain,
      version: entry.version,
      effectiveFrom: entry.effectiveFrom,
      payload: JSON.stringify(entry.payload),
      actor: entry.actor,
      createdAt: entry.createdAt,
    });

    return entry;
  }

  private readRuntimeSettings(db: Database.Database, asOf?: string): RuntimeSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<RuntimeSettings>(db, "runtime", asOf);
    if (snapshot) {
      return this.coerceRuntimeSettings(snapshot.payload);
    }

    const rows = db.prepare("SELECT key, value FROM metadata WHERE key LIKE 'runtime.%'").all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return this.coerceRuntimeSettings({
      scannerIntervalMs: map.get("runtime.scannerIntervalMs") ?? map.get("runtime.agentIntervalMs"),
      agentWakeIntervalMs: map.get("runtime.agentWakeIntervalMs"),
      deepScanIntervalMs: map.get("runtime.deepScanIntervalMs"),
      incrementalActiveTargets: map.get("runtime.incrementalActiveTargets"),
      deepActiveTargets: map.get("runtime.deepActiveTargets"),
      incrementalPortScanHosts: map.get("runtime.incrementalPortScanHosts"),
      deepPortScanHosts: map.get("runtime.deepPortScanHosts"),
      llmDiscoveryLimit: map.get("runtime.llmDiscoveryLimit"),
      incrementalFingerprintTargets: map.get("runtime.incrementalFingerprintTargets"),
      deepFingerprintTargets: map.get("runtime.deepFingerprintTargets"),
      enableMdnsDiscovery: map.get("runtime.enableMdnsDiscovery"),
      enableSsdpDiscovery: map.get("runtime.enableSsdpDiscovery"),
      enableSnmpProbe: map.get("runtime.enableSnmpProbe"),
      enableAdvancedNmapFingerprint: map.get("runtime.enableAdvancedNmapFingerprint"),
      nmapFingerprintTimeoutMs: map.get("runtime.nmapFingerprintTimeoutMs"),
      incrementalNmapTargets: map.get("runtime.incrementalNmapTargets"),
      deepNmapTargets: map.get("runtime.deepNmapTargets"),
      enablePacketIntel: map.get("runtime.enablePacketIntel"),
      packetIntelDurationSec: map.get("runtime.packetIntelDurationSec"),
      packetIntelMaxPackets: map.get("runtime.packetIntelMaxPackets"),
      packetIntelTopTalkers: map.get("runtime.packetIntelTopTalkers"),
      enableBrowserObservation: map.get("runtime.enableBrowserObservation"),
      browserObservationTimeoutMs: map.get("runtime.browserObservationTimeoutMs"),
      incrementalBrowserObservationTargets: map.get("runtime.incrementalBrowserObservationTargets"),
      deepBrowserObservationTargets: map.get("runtime.deepBrowserObservationTargets"),
      browserObservationCaptureScreenshots: map.get("runtime.browserObservationCaptureScreenshots"),
      enableWebResearch: map.get("runtime.enableWebResearch"),
      webResearchProvider: map.get("runtime.webResearchProvider"),
      webResearchFallbackStrategy: map.get("runtime.webResearchFallbackStrategy"),
      webResearchTimeoutMs: map.get("runtime.webResearchTimeoutMs"),
      webResearchMaxResults: map.get("runtime.webResearchMaxResults"),
      webResearchDeepReadPages: map.get("runtime.webResearchDeepReadPages"),
      enableDhcpLeaseIntel: map.get("runtime.enableDhcpLeaseIntel"),
      dhcpLeaseCommandTimeoutMs: map.get("runtime.dhcpLeaseCommandTimeoutMs"),
      ouiUpdateIntervalMs: map.get("runtime.ouiUpdateIntervalMs"),
      laneBEnabled: map.get("runtime.laneBEnabled"),
      laneBAllowedEnvironments: map.get("runtime.laneBAllowedEnvironments"),
      laneBAllowedFamilies: map.get("runtime.laneBAllowedFamilies"),
      laneCMutationsInLab: map.get("runtime.laneCMutationsInLab"),
      laneCMutationsInProd: map.get("runtime.laneCMutationsInProd"),
      mutationRequireDryRunWhenSupported: map.get("runtime.mutationRequireDryRunWhenSupported"),
      approvalTtlClassBMs: map.get("runtime.approvalTtlClassBMs"),
      approvalTtlClassCMs: map.get("runtime.approvalTtlClassCMs"),
      approvalTtlClassDMs: map.get("runtime.approvalTtlClassDMs"),
      quarantineThresholdCount: map.get("runtime.quarantineThresholdCount"),
      quarantineThresholdWindowMs: map.get("runtime.quarantineThresholdWindowMs"),
      availabilityScannerAlertsEnabled: map.get("runtime.availabilityScannerAlertsEnabled"),
      securityScannerAlertsEnabled: map.get("runtime.securityScannerAlertsEnabled"),
      serviceContractScannerAlertsEnabled: map.get("runtime.serviceContractScannerAlertsEnabled"),
      ignoredIncidentTypes: map.get("runtime.ignoredIncidentTypes"),
      localToolInstallPolicy: map.get("runtime.localToolInstallPolicy"),
      localToolExecutionPolicy: map.get("runtime.localToolExecutionPolicy"),
      localToolApprovalTtlMs: map.get("runtime.localToolApprovalTtlMs"),
      localToolHealthCheckIntervalMs: map.get("runtime.localToolHealthCheckIntervalMs"),
      localToolAutoInstallBuiltins: map.get("runtime.localToolAutoInstallBuiltins"),
      protocolSessionSweepIntervalMs: map.get("runtime.protocolSessionSweepIntervalMs"),
      protocolSessionDefaultLeaseTtlMs: map.get("runtime.protocolSessionDefaultLeaseTtlMs"),
      protocolSessionMaxLeaseTtlMs: map.get("runtime.protocolSessionMaxLeaseTtlMs"),
      protocolSessionMessageRetentionLimit: map.get("runtime.protocolSessionMessageRetentionLimit"),
      protocolSessionReconnectBaseMs: map.get("runtime.protocolSessionReconnectBaseMs"),
      protocolSessionReconnectMaxMs: map.get("runtime.protocolSessionReconnectMaxMs"),
    });
  }

  private readSystemSettings(db: Database.Database, asOf?: string): SystemSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<SystemSettings>(db, "system", asOf);
    if (snapshot) {
      return this.coerceSystemSettings(snapshot.payload);
    }

    return this.coerceSystemSettings({
      nodeIdentity: this.readSettingFromMetadata(db, "system.nodeIdentity"),
      timezone: this.readSettingFromMetadata(db, "system.timezone"),
      digestScheduleEnabled: this.readSettingFromMetadata(db, "system.digestScheduleEnabled"),
      digestHourLocal: this.readSettingFromMetadata(db, "system.digestHourLocal"),
      digestMinuteLocal: this.readSettingFromMetadata(db, "system.digestMinuteLocal"),
      upgradeChannel: this.readSettingFromMetadata(db, "system.upgradeChannel") as SystemSettings["upgradeChannel"] | undefined,
    });
  }

  private readAuthSettings(db: Database.Database, asOf?: string): AuthSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<AuthSettings>(db, "auth", asOf);
    if (snapshot) {
      return this.coerceAuthSettings(snapshot.payload);
    }

    const hash = this.readSettingFromMetadata(db, "auth.apiTokenHash");
    const enabledRaw = this.readSettingFromMetadata(db, "auth.apiTokenEnabled");
    return this.coerceAuthSettings({
      apiTokenEnabled: Boolean(hash) || enabledRaw === "true" || enabledRaw === "1",
      mode: this.readSettingFromMetadata(db, "auth.mode"),
      sessionTtlHours: this.readSettingFromMetadata(db, "auth.sessionTtlHours"),
      oidc: {
        enabled: this.readSettingFromMetadata(db, "auth.oidc.enabled"),
        issuer: this.readSettingFromMetadata(db, "auth.oidc.issuer"),
        clientId: this.readSettingFromMetadata(db, "auth.oidc.clientId"),
        scopes: this.readSettingFromMetadata(db, "auth.oidc.scopes"),
        autoProvision: this.readSettingFromMetadata(db, "auth.oidc.autoProvision"),
        defaultRole: this.readSettingFromMetadata(db, "auth.oidc.defaultRole"),
        clientSecretConfigured: this.readSettingFromMetadata(db, "auth.oidc.clientSecretConfigured"),
      },
      ldap: {
        enabled: this.readSettingFromMetadata(db, "auth.ldap.enabled"),
        url: this.readSettingFromMetadata(db, "auth.ldap.url"),
        baseDn: this.readSettingFromMetadata(db, "auth.ldap.baseDn"),
        bindDn: this.readSettingFromMetadata(db, "auth.ldap.bindDn"),
        userFilter: this.readSettingFromMetadata(db, "auth.ldap.userFilter"),
        uidAttribute: this.readSettingFromMetadata(db, "auth.ldap.uidAttribute"),
        autoProvision: this.readSettingFromMetadata(db, "auth.ldap.autoProvision"),
        defaultRole: this.readSettingFromMetadata(db, "auth.ldap.defaultRole"),
        bindPasswordConfigured: this.readSettingFromMetadata(db, "auth.ldap.bindPasswordConfigured"),
      },
    });
  }

  getState(): Promise<StewardState> {
    const state = this.withDbRecovery("StateStore.getState", (db) => {
      const devices = (db.prepare("SELECT * FROM devices").all() as Record<string, unknown>[]).map(deviceFromRow);
      const baselines = (db.prepare("SELECT * FROM device_baselines").all() as Record<string, unknown>[]).map(baselineFromRow);
      const incidents = (db.prepare("SELECT * FROM incidents").all() as Record<string, unknown>[]).map(incidentFromRow);
      const recommendations = (db.prepare("SELECT * FROM recommendations").all() as Record<string, unknown>[]).map(recommendationFromRow);
      const actions = this.readRecentAuditEvents(2_000);
      const graphNodes = (db.prepare("SELECT * FROM graph_nodes").all() as Record<string, unknown>[]).map(graphNodeFromRow);
      const graphEdges = (db.prepare('SELECT id, "from", "to", type, properties, createdAt, updatedAt FROM graph_edges').all() as Record<string, unknown>[]).map(graphEdgeFromRow);
      const providerConfigs = (db.prepare("SELECT * FROM provider_configs").all() as Record<string, unknown>[]).map(providerConfigFromRow);
      const oauthStates = (db.prepare("SELECT * FROM oauth_states").all() as Record<string, unknown>[]).map(oauthStateFromRow);
      const scannerRuns = (db.prepare("SELECT * FROM scanner_runs ORDER BY startedAt DESC").all() as Record<string, unknown>[]).map(scannerRunFromRow);
      const agentRuns = (db.prepare("SELECT * FROM agent_runs ORDER BY startedAt DESC").all() as Record<string, unknown>[]).map(agentRunFromRow);
      const runtimeSettings = this.readRuntimeSettings(db);
      const systemSettings = this.readSystemSettings(db);
      const authSettings = this.readAuthSettings(db);
      const policyRules = (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
      const maintenanceWindows = (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
      const playbookRuns = (db.prepare("SELECT * FROM playbook_runs ORDER BY createdAt DESC").all() as Record<string, unknown>[]).map(playbookRunFromRow);
      const dailyDigests = (db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC").all() as Record<string, unknown>[]).map(dailyDigestFromRow);
      const localTools = (db.prepare("SELECT * FROM local_tools ORDER BY id ASC").all() as Record<string, unknown>[]).map(localToolRecordFromRow);
      const localToolApprovals = (db.prepare("SELECT * FROM local_tool_approvals ORDER BY requestedAt DESC").all() as Record<string, unknown>[]).map(localToolApprovalFromRow);
      const protocolSessions = (db.prepare("SELECT * FROM protocol_sessions ORDER BY updatedAt DESC").all() as Record<string, unknown>[]).map(protocolSessionRecordFromRow);
      const protocolSessionLeases = (db.prepare("SELECT * FROM protocol_session_leases ORDER BY requestedAt DESC").all() as Record<string, unknown>[]).map(protocolSessionLeaseFromRow);
      const dashboardWidgetPages = this.getDashboardWidgetPages(db);

      return {
        version: this.getVersion(db),
        initializedAt: this.getInitializedAt(db),
        devices,
        baselines,
        incidents,
        recommendations,
        actions,
        graph: { nodes: graphNodes, edges: graphEdges },
        providerConfigs,
        oauthStates,
        scannerRuns,
        agentRuns,
        runtimeSettings,
        systemSettings,
        authSettings,
        policyRules,
        maintenanceWindows,
        playbookRuns,
        dailyDigests,
        localTools,
        localToolApprovals,
        protocolSessions,
        protocolSessionLeases,
        dashboardWidgetPages,
      };
    });

    return Promise.resolve(state);
  }

  async updateState(
    updater: (state: StewardState) => StewardState | Promise<StewardState>,
  ): Promise<StewardState> {
    const current = await this.getState();
    const next = await updater(current);
    this.writeFullState(next);
    return next;
  }

  private writeFullState(state: StewardState): void {
    this.withDbRecovery("StateStore.writeFullState", (db) => {
      const writeTx = db.transaction(() => {
      // Metadata
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('version', ?)").run(String(state.version));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('initializedAt', ?)").run(state.initializedAt);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.scannerIntervalMs', ?)").run(String(state.runtimeSettings.scannerIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.agentIntervalMs', ?)").run(String(state.runtimeSettings.scannerIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.agentWakeIntervalMs', ?)").run(String(state.runtimeSettings.agentWakeIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepScanIntervalMs', ?)").run(String(state.runtimeSettings.deepScanIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalActiveTargets', ?)").run(String(state.runtimeSettings.incrementalActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepActiveTargets', ?)").run(String(state.runtimeSettings.deepActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalPortScanHosts', ?)").run(String(state.runtimeSettings.incrementalPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepPortScanHosts', ?)").run(String(state.runtimeSettings.deepPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.llmDiscoveryLimit', ?)").run(String(state.runtimeSettings.llmDiscoveryLimit));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalFingerprintTargets', ?)").run(String(state.runtimeSettings.incrementalFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepFingerprintTargets', ?)").run(String(state.runtimeSettings.deepFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableMdnsDiscovery', ?)").run(state.runtimeSettings.enableMdnsDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSsdpDiscovery', ?)").run(state.runtimeSettings.enableSsdpDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSnmpProbe', ?)").run(state.runtimeSettings.enableSnmpProbe ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableAdvancedNmapFingerprint', ?)").run(state.runtimeSettings.enableAdvancedNmapFingerprint ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.nmapFingerprintTimeoutMs', ?)").run(String(state.runtimeSettings.nmapFingerprintTimeoutMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalNmapTargets', ?)").run(String(state.runtimeSettings.incrementalNmapTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepNmapTargets', ?)").run(String(state.runtimeSettings.deepNmapTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enablePacketIntel', ?)").run(state.runtimeSettings.enablePacketIntel ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.packetIntelDurationSec', ?)").run(String(state.runtimeSettings.packetIntelDurationSec));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.packetIntelMaxPackets', ?)").run(String(state.runtimeSettings.packetIntelMaxPackets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.packetIntelTopTalkers', ?)").run(String(state.runtimeSettings.packetIntelTopTalkers));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableBrowserObservation', ?)").run(state.runtimeSettings.enableBrowserObservation ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.browserObservationTimeoutMs', ?)").run(String(state.runtimeSettings.browserObservationTimeoutMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalBrowserObservationTargets', ?)").run(String(state.runtimeSettings.incrementalBrowserObservationTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepBrowserObservationTargets', ?)").run(String(state.runtimeSettings.deepBrowserObservationTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.browserObservationCaptureScreenshots', ?)").run(state.runtimeSettings.browserObservationCaptureScreenshots ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableWebResearch', ?)").run(state.runtimeSettings.enableWebResearch ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.webResearchProvider', ?)").run(String(state.runtimeSettings.webResearchProvider));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.webResearchFallbackStrategy', ?)").run(String(state.runtimeSettings.webResearchFallbackStrategy));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.webResearchTimeoutMs', ?)").run(String(state.runtimeSettings.webResearchTimeoutMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.webResearchMaxResults', ?)").run(String(state.runtimeSettings.webResearchMaxResults));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.webResearchDeepReadPages', ?)").run(String(state.runtimeSettings.webResearchDeepReadPages));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableDhcpLeaseIntel', ?)").run(state.runtimeSettings.enableDhcpLeaseIntel ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.dhcpLeaseCommandTimeoutMs', ?)").run(String(state.runtimeSettings.dhcpLeaseCommandTimeoutMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.ouiUpdateIntervalMs', ?)").run(String(state.runtimeSettings.ouiUpdateIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBEnabled', ?)").run(state.runtimeSettings.laneBEnabled ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBAllowedEnvironments', ?)").run(JSON.stringify(state.runtimeSettings.laneBAllowedEnvironments));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBAllowedFamilies', ?)").run(JSON.stringify(state.runtimeSettings.laneBAllowedFamilies));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneCMutationsInLab', ?)").run(state.runtimeSettings.laneCMutationsInLab ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneCMutationsInProd', ?)").run(state.runtimeSettings.laneCMutationsInProd ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.mutationRequireDryRunWhenSupported', ?)").run(state.runtimeSettings.mutationRequireDryRunWhenSupported ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassBMs', ?)").run(String(state.runtimeSettings.approvalTtlClassBMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassCMs', ?)").run(String(state.runtimeSettings.approvalTtlClassCMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassDMs', ?)").run(String(state.runtimeSettings.approvalTtlClassDMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.quarantineThresholdCount', ?)").run(String(state.runtimeSettings.quarantineThresholdCount));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.quarantineThresholdWindowMs', ?)").run(String(state.runtimeSettings.quarantineThresholdWindowMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.availabilityScannerAlertsEnabled', ?)").run(state.runtimeSettings.availabilityScannerAlertsEnabled ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.securityScannerAlertsEnabled', ?)").run(state.runtimeSettings.securityScannerAlertsEnabled ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.serviceContractScannerAlertsEnabled', ?)").run(state.runtimeSettings.serviceContractScannerAlertsEnabled ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.ignoredIncidentTypes', ?)").run(JSON.stringify(state.runtimeSettings.ignoredIncidentTypes));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.localToolInstallPolicy', ?)").run(state.runtimeSettings.localToolInstallPolicy);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.localToolExecutionPolicy', ?)").run(state.runtimeSettings.localToolExecutionPolicy);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.localToolApprovalTtlMs', ?)").run(String(state.runtimeSettings.localToolApprovalTtlMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.localToolHealthCheckIntervalMs', ?)").run(String(state.runtimeSettings.localToolHealthCheckIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.localToolAutoInstallBuiltins', ?)").run(String(state.runtimeSettings.localToolAutoInstallBuiltins));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionSweepIntervalMs', ?)").run(String(state.runtimeSettings.protocolSessionSweepIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionDefaultLeaseTtlMs', ?)").run(String(state.runtimeSettings.protocolSessionDefaultLeaseTtlMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionMaxLeaseTtlMs', ?)").run(String(state.runtimeSettings.protocolSessionMaxLeaseTtlMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionMessageRetentionLimit', ?)").run(String(state.runtimeSettings.protocolSessionMessageRetentionLimit));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionReconnectBaseMs', ?)").run(String(state.runtimeSettings.protocolSessionReconnectBaseMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.protocolSessionReconnectMaxMs', ?)").run(String(state.runtimeSettings.protocolSessionReconnectMaxMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.nodeIdentity', ?)").run(state.systemSettings.nodeIdentity);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.timezone', ?)").run(state.systemSettings.timezone);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestScheduleEnabled', ?)").run(String(state.systemSettings.digestScheduleEnabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestHourLocal', ?)").run(String(state.systemSettings.digestHourLocal));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestMinuteLocal', ?)").run(String(state.systemSettings.digestMinuteLocal));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.upgradeChannel', ?)").run(state.systemSettings.upgradeChannel);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', ?)").run(String(state.authSettings.apiTokenEnabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.mode', ?)").run(state.authSettings.mode);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.sessionTtlHours', ?)").run(String(state.authSettings.sessionTtlHours));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.enabled', ?)").run(String(state.authSettings.oidc.enabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.issuer', ?)").run(state.authSettings.oidc.issuer);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.clientId', ?)").run(state.authSettings.oidc.clientId);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.scopes', ?)").run(state.authSettings.oidc.scopes);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.autoProvision', ?)").run(String(state.authSettings.oidc.autoProvision));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.defaultRole', ?)").run(state.authSettings.oidc.defaultRole);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.clientSecretConfigured', ?)").run(String(state.authSettings.oidc.clientSecretConfigured));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.enabled', ?)").run(String(state.authSettings.ldap.enabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.url', ?)").run(state.authSettings.ldap.url);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.baseDn', ?)").run(state.authSettings.ldap.baseDn);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.bindDn', ?)").run(state.authSettings.ldap.bindDn);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.userFilter', ?)").run(state.authSettings.ldap.userFilter);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.uidAttribute', ?)").run(state.authSettings.ldap.uidAttribute);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.autoProvision', ?)").run(String(state.authSettings.ldap.autoProvision));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.defaultRole', ?)").run(state.authSettings.ldap.defaultRole);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.bindPasswordConfigured', ?)").run(String(state.authSettings.ldap.bindPasswordConfigured));

      // Devices (upsert + delete stale; avoid full-table delete to preserve FK-linked child rows)
      const upsertDevice = db.prepare(`
        INSERT INTO devices (id, name, ip, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata, secondaryIps)
        VALUES (@id, @name, @ip, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata, @secondaryIps)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          ip = excluded.ip,
          mac = excluded.mac,
          hostname = excluded.hostname,
          vendor = excluded.vendor,
          os = excluded.os,
          role = excluded.role,
          type = excluded.type,
          status = excluded.status,
          autonomyTier = excluded.autonomyTier,
          tags = excluded.tags,
          protocols = excluded.protocols,
          services = excluded.services,
          firstSeenAt = excluded.firstSeenAt,
          lastSeenAt = excluded.lastSeenAt,
          lastChangedAt = excluded.lastChangedAt,
          metadata = excluded.metadata,
          secondaryIps = excluded.secondaryIps
      `);
      const nextDeviceIds = new Set<string>();
      for (const d of state.devices) {
        nextDeviceIds.add(d.id);
        upsertDevice.run({
          id: d.id, name: d.name, ip: d.ip, mac: d.mac ?? null, hostname: d.hostname ?? null,
          vendor: d.vendor ?? null, os: d.os ?? null, role: d.role ?? null, type: d.type,
          status: d.status, autonomyTier: d.autonomyTier, tags: JSON.stringify(d.tags),
          protocols: JSON.stringify(d.protocols), services: JSON.stringify(d.services),
          firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastChangedAt: d.lastChangedAt,
          metadata: JSON.stringify(d.metadata), secondaryIps: JSON.stringify(d.secondaryIps ?? []),
        });
      }
      if (nextDeviceIds.size === 0) {
        db.prepare("DELETE FROM devices").run();
      } else {
        const placeholders = Array.from(nextDeviceIds).map(() => "?").join(",");
        db.prepare(`DELETE FROM devices WHERE id NOT IN (${placeholders})`).run(...Array.from(nextDeviceIds));
      }

      // Baselines
      db.prepare("DELETE FROM device_baselines").run();
      const insertBaseline = db.prepare(`
        INSERT INTO device_baselines (deviceId, avgLatencyMs, maxLatencyMs, minLatencyMs, samples, lastUpdatedAt)
        VALUES (@deviceId, @avgLatencyMs, @maxLatencyMs, @minLatencyMs, @samples, @lastUpdatedAt)
      `);
      for (const b of state.baselines) {
        insertBaseline.run(b);
      }

      // Incidents
      db.prepare("DELETE FROM incidents").run();
      const insertIncident = db.prepare(`
        INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
        VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
      `);
      for (const inc of state.incidents) {
        insertIncident.run({
          id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
          deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
          detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
          timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
          remediationPlan: inc.remediationPlan ?? null,
          autoRemediated: inc.autoRemediated ? 1 : 0,
          metadata: JSON.stringify(inc.metadata),
        });
      }

      // Recommendations
      db.prepare("DELETE FROM recommendations").run();
      const insertRec = db.prepare(`
        INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
        VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
      `);
      for (const r of state.recommendations) {
        insertRec.run({
          id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
          priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
          createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
        });
      }

      // Graph nodes
      db.prepare("DELETE FROM graph_nodes").run();
      const insertNode = db.prepare(`
        INSERT INTO graph_nodes (id, type, label, properties, createdAt, updatedAt)
        VALUES (@id, @type, @label, @properties, @createdAt, @updatedAt)
      `);
      for (const n of state.graph.nodes) {
        insertNode.run({
          id: n.id, type: n.type, label: n.label,
          properties: JSON.stringify(n.properties),
          createdAt: n.createdAt, updatedAt: n.updatedAt,
        });
      }

      // Graph edges
      db.prepare("DELETE FROM graph_edges").run();
      const insertEdge = db.prepare(`
        INSERT INTO graph_edges (id, "from", "to", type, properties, createdAt, updatedAt)
        VALUES (@id, @from, @to, @type, @properties, @createdAt, @updatedAt)
      `);
      for (const e of state.graph.edges) {
        insertEdge.run({
          id: e.id, from: e.from, to: e.to, type: e.type,
          properties: JSON.stringify(e.properties),
          createdAt: e.createdAt, updatedAt: e.updatedAt,
        });
      }

      // Provider configs
      db.prepare("DELETE FROM provider_configs").run();
      const insertProvider = db.prepare(`
        INSERT INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `);
      for (const p of state.providerConfigs) {
        insertProvider.run({
          provider: p.provider, enabled: p.enabled ? 1 : 0, model: p.model,
          apiKeyEnvVar: p.apiKeyEnvVar ?? null, oauthTokenSecret: p.oauthTokenSecret ?? null,
          oauthClientIdEnvVar: p.oauthClientIdEnvVar ?? null,
          oauthClientSecretEnvVar: p.oauthClientSecretEnvVar ?? null,
          oauthAuthUrl: p.oauthAuthUrl ?? null, oauthTokenUrl: p.oauthTokenUrl ?? null,
          oauthScopes: p.oauthScopes ? JSON.stringify(p.oauthScopes) : null,
          baseUrl: p.baseUrl ?? null,
          extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
        });
      }

      // OAuth states
      db.prepare("DELETE FROM oauth_states").run();
      const insertOAuth = db.prepare(`
        INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
        VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
      `);
      for (const o of state.oauthStates) {
        insertOAuth.run(o);
      }

      // Scanner runs
      db.prepare("DELETE FROM scanner_runs").run();
      const insertScannerRun = db.prepare(`
        INSERT INTO scanner_runs (id, startedAt, completedAt, outcome, summary, details)
        VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
      `);
      for (const r of state.scannerRuns) {
        insertScannerRun.run({
          id: r.id, startedAt: r.startedAt, completedAt: r.completedAt ?? null,
          outcome: r.outcome, summary: r.summary, details: JSON.stringify(r.details),
        });
      }

      // Agent runs
      db.prepare("DELETE FROM agent_runs").run();
      const insertRun = db.prepare(`
        INSERT INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
        VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
      `);
      for (const r of state.agentRuns) {
        insertRun.run({
          id: r.id, startedAt: r.startedAt, completedAt: r.completedAt ?? null,
          outcome: r.outcome, summary: r.summary, details: JSON.stringify(r.details),
        });
      }

      // Policy rules
      db.prepare("DELETE FROM policy_rules").run();
      const insertPolicyRule = db.prepare(`
        INSERT INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `);
      for (const rule of state.policyRules) {
        insertPolicyRule.run({
          id: rule.id, name: rule.name, description: rule.description,
          actionClasses: JSON.stringify(rule.actionClasses ?? []),
          autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
          environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
          deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
          decision: rule.decision, priority: rule.priority,
          enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
        });
      }

      // Maintenance windows
      db.prepare("DELETE FROM maintenance_windows").run();
      const insertWindow = db.prepare(`
        INSERT INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `);
      for (const w of state.maintenanceWindows) {
        insertWindow.run({
          id: w.id, name: w.name, deviceIds: JSON.stringify(w.deviceIds),
          cronStart: w.cronStart, durationMinutes: w.durationMinutes,
          enabled: w.enabled ? 1 : 0, createdAt: w.createdAt,
        });
      }

      // Playbook runs
      db.prepare("DELETE FROM playbook_runs").run();
      const insertPlaybookRun = db.prepare(`
        INSERT INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `);
      for (const pr of state.playbookRuns) {
        insertPlaybookRun.run({
          id: pr.id, playbookId: pr.playbookId, family: pr.family, name: pr.name,
          deviceId: pr.deviceId, incidentId: pr.incidentId ?? null,
          actionClass: pr.actionClass, status: pr.status,
          policyEvaluation: JSON.stringify(pr.policyEvaluation),
          steps: JSON.stringify(pr.steps),
          verificationSteps: JSON.stringify(pr.verificationSteps),
          rollbackSteps: JSON.stringify(pr.rollbackSteps),
          evidence: JSON.stringify(pr.evidence),
          createdAt: pr.createdAt, startedAt: pr.startedAt ?? null,
          completedAt: pr.completedAt ?? null, approvedBy: pr.approvedBy ?? null,
          approvedAt: pr.approvedAt ?? null, deniedBy: pr.deniedBy ?? null,
          deniedAt: pr.deniedAt ?? null, denialReason: pr.denialReason ?? null,
          expiresAt: pr.expiresAt ?? null, failureCount: pr.failureCount,
        });
      }

      // Daily digests
      db.prepare("DELETE FROM daily_digests").run();
      const insertDigest = db.prepare(`
        INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
        VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
      `);
      for (const d of state.dailyDigests) {
        const { id, generatedAt, periodStart, periodEnd, ...content } = d;
        insertDigest.run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });
      }

      // Local tools
      db.prepare("DELETE FROM local_tool_approvals").run();
      db.prepare("DELETE FROM local_tools").run();
      const insertLocalTool = db.prepare(`
        INSERT INTO local_tools (
          id, manifestJson, enabled, status, healthStatus, installDir, binPathsJson, installedVersion,
          lastInstalledAt, lastCheckedAt, lastRunAt, approvedAt, error, createdAt, updatedAt
        )
        VALUES (
          @id, @manifestJson, @enabled, @status, @healthStatus, @installDir, @binPathsJson, @installedVersion,
          @lastInstalledAt, @lastCheckedAt, @lastRunAt, @approvedAt, @error, @createdAt, @updatedAt
        )
      `);
      for (const tool of state.localTools) {
        insertLocalTool.run({
          id: tool.id,
          manifestJson: JSON.stringify(tool.manifest),
          enabled: tool.enabled ? 1 : 0,
          status: tool.status,
          healthStatus: tool.healthStatus,
          installDir: tool.installDir ?? null,
          binPathsJson: JSON.stringify(tool.binPaths ?? {}),
          installedVersion: tool.installedVersion ?? null,
          lastInstalledAt: tool.lastInstalledAt ?? null,
          lastCheckedAt: tool.lastCheckedAt ?? null,
          lastRunAt: tool.lastRunAt ?? null,
          approvedAt: tool.approvedAt ?? null,
          error: tool.error ?? null,
          createdAt: tool.createdAt,
          updatedAt: tool.updatedAt,
        });
      }
      const insertLocalToolApproval = db.prepare(`
        INSERT INTO local_tool_approvals (
          id, toolId, action, status, requestedBy, requestedAt, expiresAt, reason,
          requestJson, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, decisionJson
        )
        VALUES (
          @id, @toolId, @action, @status, @requestedBy, @requestedAt, @expiresAt, @reason,
          @requestJson, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @decisionJson
        )
      `);
      for (const approval of state.localToolApprovals) {
        insertLocalToolApproval.run({
          id: approval.id,
          toolId: approval.toolId,
          action: approval.action,
          status: approval.status,
          requestedBy: approval.requestedBy,
          requestedAt: approval.requestedAt,
          expiresAt: approval.expiresAt ?? null,
          reason: approval.reason,
          requestJson: JSON.stringify(approval.requestJson ?? {}),
          approvedBy: approval.approvedBy ?? null,
          approvedAt: approval.approvedAt ?? null,
          deniedBy: approval.deniedBy ?? null,
          deniedAt: approval.deniedAt ?? null,
          denialReason: approval.denialReason ?? null,
          decisionJson: JSON.stringify(approval.decisionJson ?? {}),
        });
      }

      // Protocol sessions
      db.prepare("DELETE FROM protocol_session_messages").run();
      db.prepare("DELETE FROM protocol_session_leases").run();
      db.prepare("DELETE FROM protocol_sessions").run();
      const insertProtocolSession = db.prepare(`
        INSERT INTO protocol_sessions (
          id, deviceId, protocol, adapterId, desiredState, status, arbitrationMode, singleConnectionHint,
          keepaliveAllowed, summary, configJson, activeLeaseId, lastConnectedAt, lastDisconnectedAt,
          lastMessageAt, lastError, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @protocol, @adapterId, @desiredState, @status, @arbitrationMode, @singleConnectionHint,
          @keepaliveAllowed, @summary, @configJson, @activeLeaseId, @lastConnectedAt, @lastDisconnectedAt,
          @lastMessageAt, @lastError, @createdAt, @updatedAt
        )
      `);
      for (const session of state.protocolSessions) {
        insertProtocolSession.run({
          id: session.id,
          deviceId: session.deviceId,
          protocol: session.protocol,
          adapterId: session.adapterId ?? null,
          desiredState: session.desiredState,
          status: session.status,
          arbitrationMode: session.arbitrationMode,
          singleConnectionHint: session.singleConnectionHint ? 1 : 0,
          keepaliveAllowed: session.keepaliveAllowed ? 1 : 0,
          summary: session.summary ?? null,
          configJson: JSON.stringify(session.configJson ?? {}),
          activeLeaseId: session.activeLeaseId ?? null,
          lastConnectedAt: session.lastConnectedAt ?? null,
          lastDisconnectedAt: session.lastDisconnectedAt ?? null,
          lastMessageAt: session.lastMessageAt ?? null,
          lastError: session.lastError ?? null,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
      }
      const insertProtocolSessionLease = db.prepare(`
        INSERT INTO protocol_session_leases (
          id, sessionId, holder, purpose, mode, status, exclusive, requestedAt, grantedAt,
          releasedAt, expiresAt, metadataJson
        )
        VALUES (
          @id, @sessionId, @holder, @purpose, @mode, @status, @exclusive, @requestedAt, @grantedAt,
          @releasedAt, @expiresAt, @metadataJson
        )
      `);
      for (const lease of state.protocolSessionLeases) {
        insertProtocolSessionLease.run({
          id: lease.id,
          sessionId: lease.sessionId,
          holder: lease.holder,
          purpose: lease.purpose,
          mode: lease.mode,
          status: lease.status,
          exclusive: lease.exclusive ? 1 : 0,
          requestedAt: lease.requestedAt,
          grantedAt: lease.grantedAt ?? null,
          releasedAt: lease.releasedAt ?? null,
          expiresAt: lease.expiresAt,
          metadataJson: JSON.stringify(lease.metadataJson ?? {}),
        });
      }
      });

      writeTx();
    });
  }

  async addAction(log: Omit<ActionLog, "id" | "at">): Promise<void> {
    this.withAuditDbRecovery("StateStore.addAction", (auditDb) => {
      const entry: ActionLog = {
        id: randomUUID(),
        at: new Date().toISOString(),
        ...log,
      };

      const tx = auditDb.transaction(() => {
        auditDb.prepare(`
          INSERT INTO audit_events (id, at, actor, kind, message, context, idempotencyKey, createdAt)
          VALUES (@id, @at, @actor, @kind, @message, @context, @idempotencyKey, @createdAt)
        `).run({
          id: entry.id, at: entry.at, actor: entry.actor, kind: entry.kind,
          message: entry.message,
          context: JSON.stringify(entry.context),
          idempotencyKey: entry.id,
          createdAt: entry.at,
        });

        // Durable queue for replay guarantees.
        auditDb.prepare(`
          INSERT OR IGNORE INTO durable_jobs (id, kind, payload, status, attempts, idempotencyKey, runAfter, createdAt, updatedAt, lastError)
          VALUES (@id, @kind, @payload, 'completed', 1, @idempotencyKey, @runAfter, @createdAt, @updatedAt, NULL)
        `).run({
          id: `job:${entry.id}`,
          kind: "action_log",
          payload: JSON.stringify(entry),
          idempotencyKey: entry.id,
          runAfter: entry.at,
          createdAt: entry.at,
          updatedAt: entry.at,
        });

        // Keep max 20k rows (delete oldest beyond limit)
        auditDb.prepare(`
          DELETE FROM audit_events WHERE id NOT IN (
            SELECT id FROM audit_events ORDER BY at DESC LIMIT 20000
          )
        `).run();
      });

      tx();
    });
  }

  async upsertDevice(device: Device): Promise<Device> {
    this.withDbRecovery("StateStore.upsertDevice", (db) => {
      db.prepare(`
        INSERT INTO devices (id, name, ip, secondaryIps, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata)
        VALUES (@id, @name, @ip, @secondaryIps, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          ip = excluded.ip,
          secondaryIps = excluded.secondaryIps,
          mac = excluded.mac,
          hostname = excluded.hostname,
          vendor = excluded.vendor,
          os = excluded.os,
          role = excluded.role,
          type = excluded.type,
          status = excluded.status,
          autonomyTier = excluded.autonomyTier,
          tags = excluded.tags,
          protocols = excluded.protocols,
          services = excluded.services,
          firstSeenAt = excluded.firstSeenAt,
          lastSeenAt = excluded.lastSeenAt,
          lastChangedAt = excluded.lastChangedAt,
          metadata = excluded.metadata
      `).run({
        id: device.id, name: device.name, ip: device.ip,
        secondaryIps: JSON.stringify(device.secondaryIps ?? []),
        mac: device.mac ?? null, hostname: device.hostname ?? null,
        vendor: device.vendor ?? null, os: device.os ?? null, role: device.role ?? null,
        type: device.type, status: device.status, autonomyTier: device.autonomyTier,
        tags: JSON.stringify(device.tags), protocols: JSON.stringify(device.protocols),
        services: JSON.stringify(device.services), firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt, lastChangedAt: device.lastChangedAt,
        metadata: JSON.stringify(device.metadata),
      });
    });

    return device;
  }

  async setIncidents(incidents: Incident[]): Promise<void> {
    this.withDbRecovery("StateStore.setIncidents", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM incidents").run();
        const insert = db.prepare(`
          INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
          VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
        `);
        for (const inc of incidents) {
          insert.run({
            id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
            deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
            detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
            timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
            remediationPlan: inc.remediationPlan ?? null,
            autoRemediated: inc.autoRemediated ? 1 : 0,
            metadata: JSON.stringify(inc.metadata),
          });
        }
      });

      tx();
    });
  }

  async setRecommendations(recommendations: Recommendation[]): Promise<void> {
    this.withDbRecovery("StateStore.setRecommendations", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM recommendations").run();
        const insert = db.prepare(`
          INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
          VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
        `);
        for (const r of recommendations) {
          insert.run({
            id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
            priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
            createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
          });
        }
      });

      tx();
    });
  }

  upsertBaselines(baselines: DeviceBaseline[]): void {
    if (baselines.length === 0) {
      return;
    }
    this.withDbRecovery("StateStore.upsertBaselines", (db) => {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO device_baselines (deviceId, avgLatencyMs, maxLatencyMs, minLatencyMs, samples, lastUpdatedAt)
        VALUES (@deviceId, @avgLatencyMs, @maxLatencyMs, @minLatencyMs, @samples, @lastUpdatedAt)
      `);
      const tx = db.transaction((items: DeviceBaseline[]) => {
        for (const item of items) {
          insert.run(item);
        }
      });
      tx(baselines);
    });
  }

  async setProviderConfig(config: ProviderConfig): Promise<void> {
    this.withDbRecovery("StateStore.setProviderConfig", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `).run({
        provider: config.provider, enabled: config.enabled ? 1 : 0, model: config.model,
        apiKeyEnvVar: config.apiKeyEnvVar ?? null, oauthTokenSecret: config.oauthTokenSecret ?? null,
        oauthClientIdEnvVar: config.oauthClientIdEnvVar ?? null,
        oauthClientSecretEnvVar: config.oauthClientSecretEnvVar ?? null,
        oauthAuthUrl: config.oauthAuthUrl ?? null, oauthTokenUrl: config.oauthTokenUrl ?? null,
        oauthScopes: config.oauthScopes ? JSON.stringify(config.oauthScopes) : null,
        baseUrl: config.baseUrl ?? null,
        extraHeaders: config.extraHeaders ? JSON.stringify(config.extraHeaders) : null,
      });
    });
  }

  async createOAuthState(stateItem: Omit<OAuthState, "id" | "createdAt">): Promise<OAuthState> {
    return this.withDbRecovery("StateStore.createOAuthState", (db) => {
      const created: OAuthState = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...stateItem,
      };

      const tx = db.transaction(() => {
        // Clean expired states first
        db.prepare("DELETE FROM oauth_states WHERE expiresAt < ?").run(new Date().toISOString());

        // Limit to 100 entries
        db.prepare(`
          DELETE FROM oauth_states WHERE id NOT IN (
            SELECT id FROM oauth_states ORDER BY createdAt DESC LIMIT 99
          )
        `).run();

        db.prepare(`
          INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
          VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
        `).run(created);
      });

      tx();
      return created;
    });
  }

  async consumeOAuthState(id: string): Promise<OAuthState | undefined> {
    return this.withDbRecovery("StateStore.consumeOAuthState", (db) => {
      let result: OAuthState | undefined;

      const tx = db.transaction(() => {
        const row = db.prepare("SELECT * FROM oauth_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (row) {
          result = oauthStateFromRow(row);
        }
        db.prepare("DELETE FROM oauth_states WHERE id = ?").run(id);
      });

      tx();

      if (!result) return undefined;
      if (new Date(result.expiresAt).getTime() < Date.now()) return undefined;

      return result;
    });
  }

  async addAgentRun(run: AgentRunRecord): Promise<void> {
    await this.upsertAgentRun(run);
  }

  async addScannerRun(run: ScannerRunRecord): Promise<void> {
    await this.upsertScannerRun(run);
  }

  async upsertScannerRun(run: ScannerRunRecord): Promise<void> {
    this.withDbRecovery("StateStore.upsertScannerRun", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO scanner_runs (id, startedAt, completedAt, outcome, summary, details)
          VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
        `).run({
          id: run.id,
          startedAt: run.startedAt,
          completedAt: run.completedAt ?? null,
          outcome: run.outcome,
          summary: run.summary,
          details: JSON.stringify(run.details),
        });

        db.prepare(`
          DELETE FROM scanner_runs WHERE id NOT IN (
            SELECT id FROM scanner_runs ORDER BY startedAt DESC LIMIT 200
          )
        `).run();
      });

      tx();
    });
  }

  getLatestScannerRun(): ScannerRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestScannerRun", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM scanner_runs
        ORDER BY startedAt DESC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      return row ? scannerRunFromRow(row) : null;
    });
  }

  getLatestSuccessfulScannerRun(): ScannerRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestSuccessfulScannerRun", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM scanner_runs
        WHERE outcome = 'ok' AND completedAt IS NOT NULL
        ORDER BY completedAt DESC, startedAt DESC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      return row ? scannerRunFromRow(row) : null;
    });
  }

  markStaleScannerRuns(maxAgeMs: number): number {
    return this.withDbRecovery("StateStore.markStaleScannerRuns", (db) => {
      const safeMaxAgeMs = Math.max(60_000, Math.floor(maxAgeMs));
      const now = new Date().toISOString();
      const cutoffMs = Date.now() - safeMaxAgeMs;
      const rows = db.prepare(`
        SELECT id, startedAt, summary, details
        FROM scanner_runs
        WHERE completedAt IS NULL
      `).all() as Array<Record<string, unknown>>;
      const update = db.prepare(`
        UPDATE scanner_runs
        SET completedAt = @completedAt,
            outcome = 'error',
            summary = @summary,
            details = @details
        WHERE id = @id
      `);

      let changes = 0;
      for (const row of rows) {
        const details = parseJsonObject(row.details as string);
        const holderPid = Number(details.pid ?? leaseHolderPid(details.holder));
        const holderAlive = !Number.isFinite(holderPid) || processExists(holderPid);
        const startedAtMs = Date.parse(String(row.startedAt ?? ""));
        const staleByAge = !Number.isFinite(startedAtMs) || startedAtMs <= cutoffMs;
        if (!staleByAge && holderAlive) {
          continue;
        }

        const nextSummary = (() => {
          const current = String(row.summary ?? "").trim();
          if (!current) {
            return "Scanner cycle interrupted before completion.";
          }
          if (current.includes("interrupted before completion")) {
            return current;
          }
          return `${current} (interrupted before completion)`;
        })();

        update.run({
          id: String(row.id),
          completedAt: now,
          summary: nextSummary,
          details: JSON.stringify({
            ...details,
            interrupted: true,
            interruptedAt: now,
          }),
        });
        changes += 1;
      }

      return changes;
    });
  }

  async upsertAgentRun(run: AgentRunRecord): Promise<void> {
    this.withDbRecovery("StateStore.addAgentRun", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
          VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
        `).run({
          id: run.id, startedAt: run.startedAt, completedAt: run.completedAt ?? null,
          outcome: run.outcome, summary: run.summary, details: JSON.stringify(run.details),
        });

        // Keep max 200 rows (delete oldest beyond limit)
        db.prepare(`
          DELETE FROM agent_runs WHERE id NOT IN (
            SELECT id FROM agent_runs ORDER BY startedAt DESC LIMIT 200
          )
        `).run();
      });

      tx();
    });
  }

  getLatestAgentRun(): AgentRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestAgentRun", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM agent_runs
        ORDER BY startedAt DESC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      return row ? agentRunFromRow(row) : null;
    });
  }

  getLatestSuccessfulAgentRun(): AgentRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestSuccessfulAgentRun", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM agent_runs
        WHERE outcome = 'ok' AND completedAt IS NOT NULL
        ORDER BY completedAt DESC, startedAt DESC
        LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      return row ? agentRunFromRow(row) : null;
    });
  }

  getLatestAgentRunByWakeReason(wakeReason: string): AgentRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestAgentRunByWakeReason", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM agent_runs
        WHERE json_extract(details, '$.wakeReason') = ?
        ORDER BY startedAt DESC
        LIMIT 1
      `).get(wakeReason) as Record<string, unknown> | undefined;
      return row ? agentRunFromRow(row) : null;
    });
  }

  getLatestSuccessfulAgentRunByWakeReason(wakeReason: string): AgentRunRecord | null {
    return this.withDbRecovery("StateStore.getLatestSuccessfulAgentRunByWakeReason", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM agent_runs
        WHERE outcome = 'ok'
          AND completedAt IS NOT NULL
          AND json_extract(details, '$.wakeReason') = ?
        ORDER BY completedAt DESC, startedAt DESC
        LIMIT 1
      `).get(wakeReason) as Record<string, unknown> | undefined;
      return row ? agentRunFromRow(row) : null;
    });
  }

  markStaleAgentRuns(maxAgeMs: number): number {
    return this.withDbRecovery("StateStore.markStaleAgentRuns", (db) => {
      const safeMaxAgeMs = Math.max(60_000, Math.floor(maxAgeMs));
      const now = new Date().toISOString();
      const cutoffMs = Date.now() - safeMaxAgeMs;
      const rows = db.prepare(`
        SELECT id, startedAt, summary, details
        FROM agent_runs
        WHERE completedAt IS NULL
      `).all() as Array<Record<string, unknown>>;
      const update = db.prepare(`
        UPDATE agent_runs
        SET completedAt = @completedAt,
            outcome = 'error',
            summary = @summary,
            details = @details
        WHERE id = @id
      `);

      let changes = 0;
      for (const row of rows) {
        const details = parseJsonObject(row.details as string);
        const holderPid = Number(details.pid ?? leaseHolderPid(details.holder));
        const holderAlive = !Number.isFinite(holderPid) || processExists(holderPid);
        const startedAtMs = Date.parse(String(row.startedAt ?? ""));
        const staleByAge = !Number.isFinite(startedAtMs) || startedAtMs <= cutoffMs;
        if (!staleByAge && holderAlive) {
          continue;
        }

        const nextSummary = (() => {
          const current = String(row.summary ?? "").trim();
          if (!current) {
            return "Scanner cycle interrupted before completion.";
          }
          if (current.includes("interrupted before completion")) {
            return current;
          }
          return `${current} (interrupted before completion)`;
        })();

        const nextDetails = {
          ...details,
          interrupted: 1,
          interruptedAt: now,
          ...(holderAlive ? {} : { interruptedReason: "holder_process_missing" }),
        };
        update.run({
          id: String(row.id),
          completedAt: now,
          summary: nextSummary,
          details: JSON.stringify(nextDetails),
        });
        changes += 1;
      }

      return changes;
    });
  }

  getRuntimeLeases(): ControlPlaneLeaseRecord[] {
    return this.withDbRecovery("StateStore.getRuntimeLeases", (db) => {
      const rows = db.prepare(`
        SELECT *
        FROM runtime_leases
        ORDER BY name ASC
      `).all() as Record<string, unknown>[];
      return rows.map(runtimeLeaseFromRow);
    });
  }

  getRuntimeLease(name: string): ControlPlaneLeaseRecord | null {
    return this.withDbRecovery("StateStore.getRuntimeLease", (db) => {
      const row = db.prepare(`
        SELECT *
        FROM runtime_leases
        WHERE name = ?
        LIMIT 1
      `).get(name) as Record<string, unknown> | undefined;
      return row ? runtimeLeaseFromRow(row) : null;
    });
  }

  tryAcquireRuntimeLease(
    name: string,
    holder: string,
    ttlMs: number,
    metadataJson?: Record<string, unknown>,
  ): { acquired: boolean; lease: ControlPlaneLeaseRecord | null } {
    return this.withDbRecovery("StateStore.tryAcquireRuntimeLease", (db) => {
      const safeTtlMs = Math.max(5_000, Math.floor(ttlMs));
      let acquired = false;
      let lease: ControlPlaneLeaseRecord | null = null;

      const tx = db.transaction(() => {
        const row = db.prepare(`
          SELECT *
          FROM runtime_leases
          WHERE name = ?
          LIMIT 1
        `).get(name) as Record<string, unknown> | undefined;
          const existing = row ? runtimeLeaseFromRow(row) : null;
          const nowMs = Date.now();
          const existingPidRaw = Number(existing?.metadataJson.pid);
        const existingHolderAlive = !Number.isFinite(existingPidRaw) || processExists(existingPidRaw);
        const expired = !existing || Number.isNaN(Date.parse(existing.expiresAt))
          || Date.parse(existing.expiresAt) <= nowMs
          || !existingHolderAlive;

        if (!existing || existing.holder === holder || expired) {
          const updatedAt = new Date(nowMs).toISOString();
            const nextLease: ControlPlaneLeaseRecord = {
              name,
              holder,
              expiresAt: new Date(nowMs + safeTtlMs).toISOString(),
            updatedAt,
            metadataJson: metadataJson ?? existing?.metadataJson ?? {},
          };
          db.prepare(`
            INSERT OR REPLACE INTO runtime_leases (name, holder, expiresAt, updatedAt, metadataJson)
            VALUES (@name, @holder, @expiresAt, @updatedAt, @metadataJson)
          `).run({
            name: nextLease.name,
            holder: nextLease.holder,
            expiresAt: nextLease.expiresAt,
            updatedAt: nextLease.updatedAt,
            metadataJson: JSON.stringify(nextLease.metadataJson),
          });
          acquired = true;
          lease = nextLease;
          return;
        }

        lease = existing;
      });

      tx();
      return { acquired, lease };
    });
  }

  releaseRuntimeLease(name: string, holder: string): boolean {
    return this.withDbRecovery("StateStore.releaseRuntimeLease", (db) => {
      const result = db.prepare(`
        DELETE FROM runtime_leases
        WHERE name = ?
          AND holder = ?
      `).run(name, holder);
      return Number(result.changes ?? 0) > 0;
    });
  }

  cleanupExpiredRuntimeLeases(): number {
    return this.withDbRecovery("StateStore.cleanupExpiredRuntimeLeases", (db) => {
      const result = db.prepare(`
        DELETE FROM runtime_leases
        WHERE expiresAt <= ?
      `).run(new Date().toISOString());
      return Number(result.changes ?? 0);
    });
  }

  getControlPlaneHealth(): ControlPlaneHealth {
    this.cleanupExpiredRuntimeLeases();
    const leases = this.getRuntimeLeases();
    const longRunningThresholdMs = 5 * 60_000;
    const queueSnapshot = this.withAuditDbRecovery("StateStore.getControlPlaneHealth.queue", (auditDb) => {
      const rows = auditDb.prepare(`
        SELECT kind, status, runAfter, updatedAt
        FROM durable_jobs
        WHERE kind <> 'action_log'
      `).all() as Array<Record<string, unknown>>;
      const lanes = new Map<string, ControlPlaneQueueLane>();
      let longRunningProcessing = 0;

      for (const row of rows) {
        const kind = String(row.kind);
        const status = String(row.status);
        const lane = lanes.get(kind) ?? {
          kind,
          pending: 0,
          processing: 0,
          completed: 0,
        };

        if (status === "pending") {
          lane.pending += 1;
          const runAfter = row.runAfter ? String(row.runAfter) : undefined;
          if (runAfter && (!lane.oldestPendingRunAfter || runAfter < lane.oldestPendingRunAfter)) {
            lane.oldestPendingRunAfter = runAfter;
          }
        } else if (status === "processing") {
          lane.processing += 1;
          const updatedAt = row.updatedAt ? String(row.updatedAt) : undefined;
          if (updatedAt && (!lane.oldestProcessingUpdatedAt || updatedAt < lane.oldestProcessingUpdatedAt)) {
            lane.oldestProcessingUpdatedAt = updatedAt;
          }
          const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
          if (Number.isFinite(updatedAtMs) && (Date.now() - updatedAtMs) > longRunningThresholdMs) {
            longRunningProcessing += 1;
          }
        } else if (status === "completed") {
          lane.completed += 1;
        }

        const updatedAt = row.updatedAt ? String(row.updatedAt) : undefined;
        if (updatedAt && (!lane.newestUpdatedAt || updatedAt > lane.newestUpdatedAt)) {
          lane.newestUpdatedAt = updatedAt;
        }

        lanes.set(kind, lane);
      }

      return {
        queue: Array.from(lanes.values()).sort((a, b) => a.kind.localeCompare(b.kind)),
        longRunningProcessing,
      };
    });

    const queue = queueSnapshot.queue;
    const summary = {
      pending: queue.reduce((total, lane) => total + lane.pending, 0),
      processing: queue.reduce((total, lane) => total + lane.processing, 0),
      longRunningProcessing: queueSnapshot.longRunningProcessing,
    };

    return {
      leases,
      queue,
      summary,
      lastSuccessfulScannerRun: this.getLatestSuccessfulScannerRun(),
      lastSuccessfulAgentWake: this.getLatestSuccessfulAgentRun(),
      lastPeriodicAgentWake: this.getLatestSuccessfulAgentRunByWakeReason("periodic_review"),
    };
  }

  getRuntimeSettings(asOf?: string): RuntimeSettings {
    return this.withDbRecovery("StateStore.getRuntimeSettings", (db) => this.readRuntimeSettings(db, asOf));
  }

  getSystemSettings(asOf?: string): SystemSettings {
    return this.withDbRecovery("StateStore.getSystemSettings", (db) => this.readSystemSettings(db, asOf));
  }

  getAuthSettings(asOf?: string): AuthSettings {
    return this.withDbRecovery("StateStore.getAuthSettings", (db) => this.readAuthSettings(db, asOf));
  }

  getApiTokenHash(): string | null {
    return this.withDbRecovery("StateStore.getApiTokenHash", (db) => {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'auth.apiTokenHash'").get() as { value: string } | undefined;
      return row?.value ?? null;
    });
  }

  getSettingsHistory(
    domain: SettingsHistoryEntry["domain"],
    limit = 100,
  ): SettingsHistoryEntry[] {
    return this.withDbRecovery("StateStore.getSettingsHistory", (db) => {
      const rows = db.prepare(`
        SELECT id, domain, version, effectiveFrom, payload, actor, createdAt
        FROM settings_history
        WHERE domain = ?
        ORDER BY version DESC
        LIMIT ?
      `).all(domain, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
      return rows.map((row) => settingsHistoryFromRow(row));
    });
  }

  setRuntimeSettings(
    settings: RuntimeSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setRuntimeSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceRuntimeSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("runtime.scannerIntervalMs", String(normalized.scannerIntervalMs));
        put.run("runtime.agentIntervalMs", String(normalized.scannerIntervalMs));
        put.run("runtime.agentWakeIntervalMs", String(normalized.agentWakeIntervalMs));
        put.run("runtime.deepScanIntervalMs", String(normalized.deepScanIntervalMs));
        put.run("runtime.incrementalActiveTargets", String(normalized.incrementalActiveTargets));
        put.run("runtime.deepActiveTargets", String(normalized.deepActiveTargets));
        put.run("runtime.incrementalPortScanHosts", String(normalized.incrementalPortScanHosts));
        put.run("runtime.deepPortScanHosts", String(normalized.deepPortScanHosts));
        put.run("runtime.llmDiscoveryLimit", String(normalized.llmDiscoveryLimit));
        put.run("runtime.incrementalFingerprintTargets", String(normalized.incrementalFingerprintTargets));
        put.run("runtime.deepFingerprintTargets", String(normalized.deepFingerprintTargets));
        put.run("runtime.enableMdnsDiscovery", String(normalized.enableMdnsDiscovery));
        put.run("runtime.enableSsdpDiscovery", String(normalized.enableSsdpDiscovery));
        put.run("runtime.enableSnmpProbe", String(normalized.enableSnmpProbe));
        put.run("runtime.enableAdvancedNmapFingerprint", String(normalized.enableAdvancedNmapFingerprint));
        put.run("runtime.nmapFingerprintTimeoutMs", String(normalized.nmapFingerprintTimeoutMs));
        put.run("runtime.incrementalNmapTargets", String(normalized.incrementalNmapTargets));
        put.run("runtime.deepNmapTargets", String(normalized.deepNmapTargets));
        put.run("runtime.enablePacketIntel", String(normalized.enablePacketIntel));
        put.run("runtime.packetIntelDurationSec", String(normalized.packetIntelDurationSec));
        put.run("runtime.packetIntelMaxPackets", String(normalized.packetIntelMaxPackets));
        put.run("runtime.packetIntelTopTalkers", String(normalized.packetIntelTopTalkers));
        put.run("runtime.enableBrowserObservation", String(normalized.enableBrowserObservation));
        put.run("runtime.browserObservationTimeoutMs", String(normalized.browserObservationTimeoutMs));
        put.run("runtime.incrementalBrowserObservationTargets", String(normalized.incrementalBrowserObservationTargets));
        put.run("runtime.deepBrowserObservationTargets", String(normalized.deepBrowserObservationTargets));
        put.run("runtime.browserObservationCaptureScreenshots", String(normalized.browserObservationCaptureScreenshots));
        put.run("runtime.enableWebResearch", String(normalized.enableWebResearch));
        put.run("runtime.webResearchProvider", String(normalized.webResearchProvider));
        put.run("runtime.webResearchFallbackStrategy", String(normalized.webResearchFallbackStrategy));
        put.run("runtime.webResearchTimeoutMs", String(normalized.webResearchTimeoutMs));
        put.run("runtime.webResearchMaxResults", String(normalized.webResearchMaxResults));
        put.run("runtime.webResearchDeepReadPages", String(normalized.webResearchDeepReadPages));
        put.run("runtime.enableDhcpLeaseIntel", String(normalized.enableDhcpLeaseIntel));
        put.run("runtime.dhcpLeaseCommandTimeoutMs", String(normalized.dhcpLeaseCommandTimeoutMs));
        put.run("runtime.ouiUpdateIntervalMs", String(normalized.ouiUpdateIntervalMs));
        put.run("runtime.laneBEnabled", String(normalized.laneBEnabled));
        put.run("runtime.laneBAllowedEnvironments", JSON.stringify(normalized.laneBAllowedEnvironments));
        put.run("runtime.laneBAllowedFamilies", JSON.stringify(normalized.laneBAllowedFamilies));
        put.run("runtime.laneCMutationsInLab", String(normalized.laneCMutationsInLab));
        put.run("runtime.laneCMutationsInProd", String(normalized.laneCMutationsInProd));
        put.run("runtime.mutationRequireDryRunWhenSupported", String(normalized.mutationRequireDryRunWhenSupported));
        put.run("runtime.approvalTtlClassBMs", String(normalized.approvalTtlClassBMs));
        put.run("runtime.approvalTtlClassCMs", String(normalized.approvalTtlClassCMs));
        put.run("runtime.approvalTtlClassDMs", String(normalized.approvalTtlClassDMs));
        put.run("runtime.quarantineThresholdCount", String(normalized.quarantineThresholdCount));
        put.run("runtime.quarantineThresholdWindowMs", String(normalized.quarantineThresholdWindowMs));
        put.run("runtime.availabilityScannerAlertsEnabled", String(normalized.availabilityScannerAlertsEnabled));
        put.run("runtime.securityScannerAlertsEnabled", String(normalized.securityScannerAlertsEnabled));
        put.run("runtime.serviceContractScannerAlertsEnabled", String(normalized.serviceContractScannerAlertsEnabled));
        put.run("runtime.ignoredIncidentTypes", JSON.stringify(normalized.ignoredIncidentTypes));
        put.run("runtime.localToolInstallPolicy", normalized.localToolInstallPolicy);
        put.run("runtime.localToolExecutionPolicy", normalized.localToolExecutionPolicy);
        put.run("runtime.localToolApprovalTtlMs", String(normalized.localToolApprovalTtlMs));
        put.run("runtime.localToolHealthCheckIntervalMs", String(normalized.localToolHealthCheckIntervalMs));
        put.run("runtime.localToolAutoInstallBuiltins", String(normalized.localToolAutoInstallBuiltins));
        put.run("runtime.protocolSessionSweepIntervalMs", String(normalized.protocolSessionSweepIntervalMs));
        put.run("runtime.protocolSessionDefaultLeaseTtlMs", String(normalized.protocolSessionDefaultLeaseTtlMs));
        put.run("runtime.protocolSessionMaxLeaseTtlMs", String(normalized.protocolSessionMaxLeaseTtlMs));
        put.run("runtime.protocolSessionMessageRetentionLimit", String(normalized.protocolSessionMessageRetentionLimit));
        put.run("runtime.protocolSessionReconnectBaseMs", String(normalized.protocolSessionReconnectBaseMs));
        put.run("runtime.protocolSessionReconnectMaxMs", String(normalized.protocolSessionReconnectMaxMs));
        this.appendSettingsHistory(
          db,
          "runtime",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setSystemSettings(
    settings: SystemSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setSystemSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceSystemSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("system.nodeIdentity", normalized.nodeIdentity);
        put.run("system.timezone", normalized.timezone);
        put.run("system.digestScheduleEnabled", String(normalized.digestScheduleEnabled));
        put.run("system.digestHourLocal", String(normalized.digestHourLocal));
        put.run("system.digestMinuteLocal", String(normalized.digestMinuteLocal));
        put.run("system.upgradeChannel", normalized.upgradeChannel);
        this.appendSettingsHistory(
          db,
          "system",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setApiTokenHash(
    hash: string | null,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setApiTokenHash", (db) => {
      const write = db.transaction(() => {
        if (hash) {
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenHash', ?)").run(hash);
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', 'true')").run();
        } else {
          db.prepare("DELETE FROM metadata WHERE key = 'auth.apiTokenHash'").run();
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', 'false')").run();
        }
        const current = this.readAuthSettings(db);
        const authSettings: AuthSettings = {
          ...current,
          apiTokenEnabled: Boolean(hash),
        };
        this.appendSettingsHistory(
          db,
          "auth",
          authSettings as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setAuthSettings(
    settings: AuthSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setAuthSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceAuthSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("auth.apiTokenEnabled", String(normalized.apiTokenEnabled));
        put.run("auth.mode", normalized.mode);
        put.run("auth.sessionTtlHours", String(normalized.sessionTtlHours));
        put.run("auth.oidc.enabled", String(normalized.oidc.enabled));
        put.run("auth.oidc.issuer", normalized.oidc.issuer);
        put.run("auth.oidc.clientId", normalized.oidc.clientId);
        put.run("auth.oidc.scopes", normalized.oidc.scopes);
        put.run("auth.oidc.autoProvision", String(normalized.oidc.autoProvision));
        put.run("auth.oidc.defaultRole", normalized.oidc.defaultRole);
        put.run("auth.oidc.clientSecretConfigured", String(normalized.oidc.clientSecretConfigured));
        put.run("auth.ldap.enabled", String(normalized.ldap.enabled));
        put.run("auth.ldap.url", normalized.ldap.url);
        put.run("auth.ldap.baseDn", normalized.ldap.baseDn);
        put.run("auth.ldap.bindDn", normalized.ldap.bindDn);
        put.run("auth.ldap.userFilter", normalized.ldap.userFilter);
        put.run("auth.ldap.uidAttribute", normalized.ldap.uidAttribute);
        put.run("auth.ldap.autoProvision", String(normalized.ldap.autoProvision));
        put.run("auth.ldap.defaultRole", normalized.ldap.defaultRole);
        put.run("auth.ldap.bindPasswordConfigured", String(normalized.ldap.bindPasswordConfigured));
        this.appendSettingsHistory(
          db,
          "auth",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  addDiscoveryObservations(observations: DiscoveryObservationInput[]): void {
    if (observations.length === 0) {
      return;
    }

    this.withDbRecovery("StateStore.addDiscoveryObservations", (db) => {
      const insert = db.prepare(`
        INSERT INTO discovery_observations (id, ip, deviceId, source, evidenceType, confidence, observedAt, expiresAt, details)
        VALUES (@id, @ip, @deviceId, @source, @evidenceType, @confidence, @observedAt, @expiresAt, @details)
      `);

      const tx = db.transaction((batch: DiscoveryObservationInput[]) => {
        for (const item of batch) {
          const observedAt = item.observedAt || new Date().toISOString();
          const observedAtMs = Date.parse(observedAt);
          const expiresAt = item.expiresAt
            ?? new Date(
              (Number.isFinite(observedAtMs) ? observedAtMs : Date.now()) + Math.max(1, item.ttlMs ?? 15 * 60_000),
            ).toISOString();

          insert.run({
            id: randomUUID(),
            ip: item.ip,
            deviceId: null,
            source: item.source,
            evidenceType: item.evidenceType,
            confidence: Math.max(0, Math.min(1, item.confidence)),
            observedAt,
            expiresAt,
            details: JSON.stringify(item.details ?? {}),
          });
        }
      });

      tx(observations);
    });
  }

  getRecentDiscoveryObservationsByIp(
    ips: string[],
    options?: { sinceAt?: string; limitPerIp?: number },
  ): Map<string, DiscoveryObservation[]> {
    return this.withDbRecovery("StateStore.getRecentDiscoveryObservationsByIp", (db) => {
      const deduped = Array.from(new Set(ips.filter((ip) => ip.trim().length > 0)));
      if (deduped.length === 0) {
        return new Map();
      }

      const sinceAt = options?.sinceAt ?? new Date(Date.now() - 30 * 60_000).toISOString();
      const limitPerIp = Math.max(1, Math.min(100, options?.limitPerIp ?? 25));

      const placeholders = deduped.map((_, idx) => `@ip${idx}`).join(",");
      const params: Record<string, unknown> = { sinceAt };
      deduped.forEach((ip, idx) => { params[`ip${idx}`] = ip; });

      const rows = db.prepare(`
        SELECT id, ip, deviceId, source, evidenceType, confidence, observedAt, expiresAt, details
        FROM discovery_observations
        WHERE ip IN (${placeholders}) AND observedAt >= @sinceAt
        ORDER BY observedAt DESC
      `).all(params) as Record<string, unknown>[];

      const grouped = new Map<string, DiscoveryObservation[]>();
      for (const row of rows) {
        const observation = discoveryObservationFromRow(row);
        const existing = grouped.get(observation.ip) ?? [];
        if (existing.length < limitPerIp) {
          existing.push(observation);
          grouped.set(observation.ip, existing);
        }
      }

      return grouped;
    });
  }

  attachRecentObservationsToDevice(ip: string, deviceId: string, sinceAt?: string): void {
    this.withDbRecovery("StateStore.attachRecentObservationsToDevice", (db) => {
      const cutoff = sinceAt ?? new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      db.prepare(`
        UPDATE discovery_observations
        SET deviceId = @deviceId
        WHERE ip = @ip
          AND observedAt >= @sinceAt
          AND (deviceId IS NULL OR deviceId = '')
      `).run({
        ip,
        deviceId,
        sinceAt: cutoff,
      });
    });
  }

  pruneExpiredDiscoveryObservations(maxRows = 50_000): number {
    return this.withDbRecovery("StateStore.pruneExpiredDiscoveryObservations", (db) => {
      const nowIso = new Date().toISOString();
      const tx = db.transaction(() => {
        const expired = db.prepare("DELETE FROM discovery_observations WHERE expiresAt < ?").run(nowIso);
        db.prepare(`
          DELETE FROM discovery_observations
          WHERE id NOT IN (
            SELECT id
            FROM discovery_observations
            ORDER BY observedAt DESC
            LIMIT ?
          )
        `).run(maxRows);
        return expired.changes;
      });
      return tx();
    });
  }

  getAuditEventsPage(options?: {
    limit?: number;
    cursor?: { at: string; id: string };
    actor?: ActionLog["actor"];
    kind?: ActionLog["kind"];
    sinceAt?: string;
    untilAt?: string;
  }): { events: ActionLog[]; nextCursor: { at: string; id: string } | null } {
    return this.withAuditDbRecovery("StateStore.getAuditEventsPage", (auditDb) => {
      const limit = Math.max(1, Math.min(500, options?.limit ?? 100));
      const params: Record<string, unknown> = { limit: limit + 1 };
      const conditions: string[] = [];

      if (options?.actor) {
        conditions.push("actor = @actor");
        params.actor = options.actor;
      }
      if (options?.kind) {
        conditions.push("kind = @kind");
        params.kind = options.kind;
      }
      if (options?.sinceAt) {
        conditions.push("at >= @sinceAt");
        params.sinceAt = options.sinceAt;
      }
      if (options?.untilAt) {
        conditions.push("at <= @untilAt");
        params.untilAt = options.untilAt;
      }
      if (options?.cursor) {
        conditions.push("(at < @cursorAt OR (at = @cursorAt AND id < @cursorId))");
        params.cursorAt = options.cursor.at;
        params.cursorId = options.cursor.id;
      }

      let query = "SELECT id, at, actor, kind, message, context FROM audit_events";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY at DESC, id DESC LIMIT @limit";

      const rows = auditDb.prepare(query).all(params) as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const visibleRows = hasMore ? rows.slice(0, limit) : rows;
      const events = visibleRows.map(actionFromRow);

      if (!hasMore || events.length === 0) {
        return { events, nextCursor: null };
      }

      const tail = events[events.length - 1];
      return {
        events,
        nextCursor: { at: tail.at, id: tail.id },
      };
    });
  }

  enqueueDurableJob(kind: string, payload: Record<string, unknown>, idempotencyKey: string, runAfter?: string): void {
    this.withAuditDbRecovery("StateStore.enqueueDurableJob", (auditDb) => {
      const now = new Date().toISOString();
      auditDb.prepare(`
        INSERT OR IGNORE INTO durable_jobs (id, kind, payload, status, attempts, idempotencyKey, runAfter, createdAt, updatedAt, lastError)
        VALUES (@id, @kind, @payload, 'pending', 0, @idempotencyKey, @runAfter, @createdAt, @updatedAt, NULL)
      `).run({
        id: `job:${randomUUID()}`,
        kind,
        payload: JSON.stringify(payload),
        idempotencyKey,
        runAfter: runAfter ?? now,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  claimDurableJobs(limit = 100, options?: { kinds?: string[] }): Array<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    idempotencyKey?: string;
  }> {
    return this.withAuditDbRecovery("StateStore.claimDurableJobs", (auditDb) => {
      const now = new Date().toISOString();
      const kinds = Array.from(new Set((options?.kinds ?? []).map((kind) => kind.trim()).filter(Boolean)));
      const rows = kinds.length > 0
        ? auditDb.prepare(`
          SELECT id, kind, payload, attempts, idempotencyKey
          FROM durable_jobs
          WHERE status = 'pending' AND runAfter <= ? AND kind IN (${kinds.map(() => "?").join(", ")})
          ORDER BY createdAt ASC
          LIMIT ?
        `).all(
          now,
          ...kinds,
          Math.max(1, Math.min(500, limit)),
        ) as Array<Record<string, unknown>>
        : auditDb.prepare(`
          SELECT id, kind, payload, attempts, idempotencyKey
          FROM durable_jobs
          WHERE status = 'pending' AND runAfter <= ?
          ORDER BY createdAt ASC
          LIMIT ?
        `).all(now, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;

      const tx = auditDb.transaction((jobIds: string[]) => {
        for (const id of jobIds) {
          auditDb.prepare(`
            UPDATE durable_jobs
            SET status = 'processing', attempts = attempts + 1, updatedAt = ?
            WHERE id = ?
          `).run(now, id);
        }
      });
      tx(rows.map((row) => String(row.id)));

      return rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        payload: JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>,
        attempts: Number(row.attempts ?? 0),
        idempotencyKey: row.idempotencyKey ? String(row.idempotencyKey) : undefined,
      }));
    });
  }

  requeueStaleDurableJobs(maxAgeMs: number, options?: { kinds?: string[] }): number {
    return this.withAuditDbRecovery("StateStore.requeueStaleDurableJobs", (auditDb) => {
      const safeMaxAgeMs = Math.max(10_000, Math.floor(maxAgeMs));
      const cutoffIso = new Date(Date.now() - safeMaxAgeMs).toISOString();
      const nowIso = new Date().toISOString();
      const kinds = Array.from(new Set((options?.kinds ?? []).map((kind) => kind.trim()).filter(Boolean)));
      if (kinds.length === 0) {
        const result = auditDb.prepare(`
          UPDATE durable_jobs
          SET status = 'pending', updatedAt = ?
          WHERE status = 'processing' AND updatedAt <= ?
        `).run(nowIso, cutoffIso);
        return result.changes;
      }

      const result = auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'pending', updatedAt = ?
        WHERE status = 'processing' AND updatedAt <= ? AND kind IN (${kinds.map(() => "?").join(", ")})
      `).run(nowIso, cutoffIso, ...kinds);
      return result.changes;
    });
  }

  requeueProcessingDurableJobs(options?: { kinds?: string[] }): number {
    return this.withAuditDbRecovery("StateStore.requeueProcessingDurableJobs", (auditDb) => {
      const nowIso = new Date().toISOString();
      const kinds = Array.from(new Set((options?.kinds ?? []).map((kind) => kind.trim()).filter(Boolean)));
      if (kinds.length === 0) {
        const result = auditDb.prepare(`
          UPDATE durable_jobs
          SET status = 'pending', updatedAt = ?
          WHERE status = 'processing'
        `).run(nowIso);
        return Number(result.changes ?? 0);
      }

      const result = auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'pending', updatedAt = ?
        WHERE status = 'processing' AND kind IN (${kinds.map(() => "?").join(", ")})
      `).run(nowIso, ...kinds);
      return Number(result.changes ?? 0);
    });
  }

  completeDurableJob(id: string): void {
    this.withAuditDbRecovery("StateStore.completeDurableJob", (auditDb) => {
      auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'completed', updatedAt = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
    });
  }

  failDurableJob(id: string, errorMessage: string, retryAfterMs = 60_000): void {
    this.withAuditDbRecovery("StateStore.failDurableJob", (auditDb) => {
      const now = Date.now();
      auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'pending', lastError = ?, runAfter = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        errorMessage,
        new Date(now + Math.max(1_000, retryAfterMs)).toISOString(),
        new Date(now).toISOString(),
        id,
      );
    });
  }

  hasDurableJobsInFlight(kinds: string[]): boolean {
    const normalizedKinds = Array.from(new Set(kinds.map((kind) => kind.trim()).filter(Boolean)));
    if (normalizedKinds.length === 0) {
      return false;
    }

    return this.withAuditDbRecovery("StateStore.hasDurableJobsInFlight", (auditDb) => {
      const row = auditDb.prepare(`
        SELECT COUNT(*) AS total
        FROM durable_jobs
        WHERE status IN ('pending', 'processing')
          AND kind IN (${normalizedKinds.map(() => "?").join(", ")})
      `).get(...normalizedKinds) as { total?: number } | undefined;
      return Number(row?.total ?? 0) > 0;
    });
  }

  /* ---------- Policy Rules ---------- */

  getPolicyRules(): PolicyRule[] {
    return this.withDbRecovery("StateStore.getPolicyRules", (db) => {
      return (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
    });
  }

  upsertPolicyRule(rule: PolicyRule): void {
    this.withDbRecovery("StateStore.upsertPolicyRule", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `).run({
        id: rule.id, name: rule.name, description: rule.description,
        actionClasses: JSON.stringify(rule.actionClasses ?? []),
        autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
        environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
        deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
        decision: rule.decision, priority: rule.priority,
        enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
      });
    });
  }

  deletePolicyRule(id: string): void {
    this.withDbRecovery("StateStore.deletePolicyRule", (db) => {
      db.prepare("DELETE FROM policy_rules WHERE id = ?").run(id);
    });
  }

  /* ---------- Maintenance Windows ---------- */

  getMaintenanceWindows(): MaintenanceWindow[] {
    return this.withDbRecovery("StateStore.getMaintenanceWindows", (db) => {
      return (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
    });
  }

  upsertMaintenanceWindow(window: MaintenanceWindow): void {
    this.withDbRecovery("StateStore.upsertMaintenanceWindow", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `).run({
        id: window.id, name: window.name, deviceIds: JSON.stringify(window.deviceIds),
        cronStart: window.cronStart, durationMinutes: window.durationMinutes,
        enabled: window.enabled ? 1 : 0, createdAt: window.createdAt,
      });
    });
  }

  deleteMaintenanceWindow(id: string): void {
    this.withDbRecovery("StateStore.deleteMaintenanceWindow", (db) => {
      db.prepare("DELETE FROM maintenance_windows WHERE id = ?").run(id);
    });
  }

  /* ---------- Playbook Runs ---------- */

  getPlaybookRuns(filter?: { status?: string; deviceId?: string }): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPlaybookRuns", (db) => {
      let query = "SELECT * FROM playbook_runs";
      const conditions: string[] = [];
      const params: Record<string, string> = {};

      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (filter?.deviceId) {
        conditions.push("deviceId = @deviceId");
        params.deviceId = filter.deviceId;
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY createdAt DESC LIMIT 500";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  getPlaybookRunById(id: string): PlaybookRun | undefined {
    return this.withDbRecovery("StateStore.getPlaybookRunById", (db) => {
      const row = db.prepare("SELECT * FROM playbook_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? playbookRunFromRow(row) : undefined;
    });
  }

  upsertPlaybookRun(run: PlaybookRun): void {
    this.withDbRecovery("StateStore.upsertPlaybookRun", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `).run({
        id: run.id, playbookId: run.playbookId, family: run.family, name: run.name,
        deviceId: run.deviceId, incidentId: run.incidentId ?? null,
        actionClass: run.actionClass, status: run.status,
        policyEvaluation: JSON.stringify(run.policyEvaluation),
        steps: JSON.stringify(run.steps),
        verificationSteps: JSON.stringify(run.verificationSteps),
        rollbackSteps: JSON.stringify(run.rollbackSteps),
        evidence: JSON.stringify(run.evidence),
        createdAt: run.createdAt, startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null, approvedBy: run.approvedBy ?? null,
        approvedAt: run.approvedAt ?? null, deniedBy: run.deniedBy ?? null,
        deniedAt: run.deniedAt ?? null, denialReason: run.denialReason ?? null,
        expiresAt: run.expiresAt ?? null, failureCount: run.failureCount,
      });
    });
  }

  getPendingApprovals(): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPendingApprovals", (db) => {
      const now = new Date().toISOString();
      return (db.prepare(
        "SELECT * FROM playbook_runs WHERE status = 'pending_approval' AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY createdAt ASC",
      ).all(now) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  /* ---------- Local Tools ---------- */

  getLocalTools(): LocalToolRecord[] {
    return this.withDbRecovery("StateStore.getLocalTools", (db) => {
      return (db.prepare("SELECT * FROM local_tools ORDER BY id ASC").all() as Record<string, unknown>[]).map(localToolRecordFromRow);
    });
  }

  getLocalToolById(id: string): LocalToolRecord | undefined {
    return this.withDbRecovery("StateStore.getLocalToolById", (db) => {
      const row = db.prepare("SELECT * FROM local_tools WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? localToolRecordFromRow(row) : undefined;
    });
  }

  upsertLocalTool(tool: LocalToolRecord): LocalToolRecord {
    return this.withDbRecovery("StateStore.upsertLocalTool", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO local_tools (
          id, manifestJson, enabled, status, healthStatus, installDir, binPathsJson, installedVersion,
          lastInstalledAt, lastCheckedAt, lastRunAt, approvedAt, error, createdAt, updatedAt
        )
        VALUES (
          @id, @manifestJson, @enabled, @status, @healthStatus, @installDir, @binPathsJson, @installedVersion,
          @lastInstalledAt, @lastCheckedAt, @lastRunAt, @approvedAt, @error, @createdAt, @updatedAt
        )
      `).run({
        id: tool.id,
        manifestJson: JSON.stringify(tool.manifest),
        enabled: tool.enabled ? 1 : 0,
        status: tool.status,
        healthStatus: tool.healthStatus,
        installDir: tool.installDir ?? null,
        binPathsJson: JSON.stringify(tool.binPaths ?? {}),
        installedVersion: tool.installedVersion ?? null,
        lastInstalledAt: tool.lastInstalledAt ?? null,
        lastCheckedAt: tool.lastCheckedAt ?? null,
        lastRunAt: tool.lastRunAt ?? null,
        approvedAt: tool.approvedAt ?? null,
        error: tool.error ?? null,
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
      });
      return tool;
    });
  }

  getLocalToolApprovals(filter?: { toolId?: string; status?: LocalToolApproval["status"] }): LocalToolApproval[] {
    return this.withDbRecovery("StateStore.getLocalToolApprovals", (db) => {
      let query = "SELECT * FROM local_tool_approvals";
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.toolId) {
        conditions.push("toolId = @toolId");
        params.toolId = filter.toolId;
      }
      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY requestedAt DESC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(localToolApprovalFromRow);
    });
  }

  getLocalToolApprovalById(id: string): LocalToolApproval | undefined {
    return this.withDbRecovery("StateStore.getLocalToolApprovalById", (db) => {
      const row = db.prepare("SELECT * FROM local_tool_approvals WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? localToolApprovalFromRow(row) : undefined;
    });
  }

  upsertLocalToolApproval(approval: LocalToolApproval): LocalToolApproval {
    return this.withDbRecovery("StateStore.upsertLocalToolApproval", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO local_tool_approvals (
          id, toolId, action, status, requestedBy, requestedAt, expiresAt, reason,
          requestJson, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, decisionJson
        )
        VALUES (
          @id, @toolId, @action, @status, @requestedBy, @requestedAt, @expiresAt, @reason,
          @requestJson, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @decisionJson
        )
      `).run({
        id: approval.id,
        toolId: approval.toolId,
        action: approval.action,
        status: approval.status,
        requestedBy: approval.requestedBy,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt ?? null,
        reason: approval.reason,
        requestJson: JSON.stringify(approval.requestJson ?? {}),
        approvedBy: approval.approvedBy ?? null,
        approvedAt: approval.approvedAt ?? null,
        deniedBy: approval.deniedBy ?? null,
        deniedAt: approval.deniedAt ?? null,
        denialReason: approval.denialReason ?? null,
        decisionJson: JSON.stringify(approval.decisionJson ?? {}),
      });
      return approval;
    });
  }

  getPendingLocalToolApprovals(): LocalToolApproval[] {
    return this.withDbRecovery("StateStore.getPendingLocalToolApprovals", (db) => {
      const now = new Date().toISOString();
      return (db.prepare(`
        SELECT * FROM local_tool_approvals
        WHERE status = 'pending'
          AND (expiresAt IS NULL OR expiresAt > ?)
        ORDER BY requestedAt ASC
      `).all(now) as Record<string, unknown>[]).map(localToolApprovalFromRow);
    });
  }

  /* ---------- Protocol Sessions ---------- */

  getProtocolSessions(filter?: {
    deviceId?: string;
    protocol?: ProtocolSessionRecord["protocol"];
    status?: ProtocolSessionRecord["status"];
  }): ProtocolSessionRecord[] {
    return this.withDbRecovery("StateStore.getProtocolSessions", (db) => {
      let query = "SELECT * FROM protocol_sessions";
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.deviceId) {
        conditions.push("deviceId = @deviceId");
        params.deviceId = filter.deviceId;
      }
      if (filter?.protocol) {
        conditions.push("protocol = @protocol");
        params.protocol = filter.protocol;
      }
      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY updatedAt DESC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(protocolSessionRecordFromRow);
    });
  }

  getProtocolSessionById(id: string): ProtocolSessionRecord | undefined {
    return this.withDbRecovery("StateStore.getProtocolSessionById", (db) => {
      const row = db.prepare("SELECT * FROM protocol_sessions WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? protocolSessionRecordFromRow(row) : undefined;
    });
  }

  upsertProtocolSession(session: ProtocolSessionRecord): ProtocolSessionRecord {
    return this.withDbRecovery("StateStore.upsertProtocolSession", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO protocol_sessions (
          id, deviceId, protocol, adapterId, desiredState, status, arbitrationMode, singleConnectionHint,
          keepaliveAllowed, summary, configJson, activeLeaseId, lastConnectedAt, lastDisconnectedAt,
          lastMessageAt, lastError, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @protocol, @adapterId, @desiredState, @status, @arbitrationMode, @singleConnectionHint,
          @keepaliveAllowed, @summary, @configJson, @activeLeaseId, @lastConnectedAt, @lastDisconnectedAt,
          @lastMessageAt, @lastError, @createdAt, @updatedAt
        )
      `).run({
        id: session.id,
        deviceId: session.deviceId,
        protocol: session.protocol,
        adapterId: session.adapterId ?? null,
        desiredState: session.desiredState,
        status: session.status,
        arbitrationMode: session.arbitrationMode,
        singleConnectionHint: session.singleConnectionHint ? 1 : 0,
        keepaliveAllowed: session.keepaliveAllowed ? 1 : 0,
        summary: session.summary ?? null,
        configJson: JSON.stringify(session.configJson ?? {}),
        activeLeaseId: session.activeLeaseId ?? null,
        lastConnectedAt: session.lastConnectedAt ?? null,
        lastDisconnectedAt: session.lastDisconnectedAt ?? null,
        lastMessageAt: session.lastMessageAt ?? null,
        lastError: session.lastError ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
      return session;
    });
  }

  deleteProtocolSession(id: string): boolean {
    return this.withDbRecovery("StateStore.deleteProtocolSession", (db) => {
      const result = db.prepare("DELETE FROM protocol_sessions WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  getProtocolSessionLeases(filter?: {
    sessionId?: string;
    holder?: string;
    status?: ProtocolSessionLease["status"];
  }): ProtocolSessionLease[] {
    return this.withDbRecovery("StateStore.getProtocolSessionLeases", (db) => {
      let query = "SELECT * FROM protocol_session_leases";
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};

      if (filter?.sessionId) {
        conditions.push("sessionId = @sessionId");
        params.sessionId = filter.sessionId;
      }
      if (filter?.holder) {
        conditions.push("holder = @holder");
        params.holder = filter.holder;
      }
      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY requestedAt DESC";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(protocolSessionLeaseFromRow);
    });
  }

  getProtocolSessionLeaseById(id: string): ProtocolSessionLease | undefined {
    return this.withDbRecovery("StateStore.getProtocolSessionLeaseById", (db) => {
      const row = db.prepare("SELECT * FROM protocol_session_leases WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? protocolSessionLeaseFromRow(row) : undefined;
    });
  }

  upsertProtocolSessionLease(lease: ProtocolSessionLease): ProtocolSessionLease {
    return this.withDbRecovery("StateStore.upsertProtocolSessionLease", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO protocol_session_leases (
          id, sessionId, holder, purpose, mode, status, exclusive, requestedAt, grantedAt,
          releasedAt, expiresAt, metadataJson
        )
        VALUES (
          @id, @sessionId, @holder, @purpose, @mode, @status, @exclusive, @requestedAt, @grantedAt,
          @releasedAt, @expiresAt, @metadataJson
        )
      `).run({
        id: lease.id,
        sessionId: lease.sessionId,
        holder: lease.holder,
        purpose: lease.purpose,
        mode: lease.mode,
        status: lease.status,
        exclusive: lease.exclusive ? 1 : 0,
        requestedAt: lease.requestedAt,
        grantedAt: lease.grantedAt ?? null,
        releasedAt: lease.releasedAt ?? null,
        expiresAt: lease.expiresAt,
        metadataJson: JSON.stringify(lease.metadataJson ?? {}),
      });
      return lease;
    });
  }

  deleteProtocolSessionLease(id: string): boolean {
    return this.withDbRecovery("StateStore.deleteProtocolSessionLease", (db) => {
      const result = db.prepare("DELETE FROM protocol_session_leases WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  getProtocolSessionMessages(sessionId: string, limit = 100): ProtocolSessionMessage[] {
    return this.withDbRecovery("StateStore.getProtocolSessionMessages", (db) => {
      return (db.prepare(`
        SELECT * FROM protocol_session_messages
        WHERE sessionId = ?
        ORDER BY observedAt DESC
        LIMIT ?
      `).all(sessionId, Math.max(1, Math.min(2_000, limit))) as Record<string, unknown>[]).map(protocolSessionMessageFromRow);
    });
  }

  addProtocolSessionMessage(message: ProtocolSessionMessage): ProtocolSessionMessage {
    return this.withDbRecovery("StateStore.addProtocolSessionMessage", (db) => {
      db.prepare(`
        INSERT INTO protocol_session_messages (
          id, sessionId, deviceId, direction, channel, payload, metadataJson, observedAt
        )
        VALUES (
          @id, @sessionId, @deviceId, @direction, @channel, @payload, @metadataJson, @observedAt
        )
      `).run({
        id: message.id,
        sessionId: message.sessionId,
        deviceId: message.deviceId,
        direction: message.direction,
        channel: message.channel,
        payload: message.payload,
        metadataJson: JSON.stringify(message.metadataJson ?? {}),
        observedAt: message.observedAt,
      });
      return message;
    });
  }

  pruneProtocolSessionMessages(sessionId: string, keepLimit: number): number {
    return this.withDbRecovery("StateStore.pruneProtocolSessionMessages", (db) => {
      const safeLimit = Math.max(0, Math.floor(keepLimit));
      const result = db.prepare(`
        DELETE FROM protocol_session_messages
        WHERE sessionId = @sessionId
          AND id NOT IN (
            SELECT id
            FROM protocol_session_messages
            WHERE sessionId = @sessionId
            ORDER BY observedAt DESC
            LIMIT @safeLimit
          )
      `).run({ sessionId, safeLimit });
      return result.changes;
    });
  }

  /* ---------- Daily Digests ---------- */

  addDigest(digest: DailyDigest): void {
    this.withDbRecovery("StateStore.addDigest", (db) => {
      const { id, generatedAt, periodStart, periodEnd, ...content } = digest;
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
          VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
        `).run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });

        // Keep max 90 digests
        db.prepare(`
          DELETE FROM daily_digests WHERE id NOT IN (
            SELECT id FROM daily_digests ORDER BY generatedAt DESC LIMIT 90
          )
        `).run();
      });
      tx();
    });
  }

  getLatestDigest(): DailyDigest | null {
    return this.withDbRecovery("StateStore.getLatestDigest", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  getDigestById(id: string): DailyDigest | null {
    return this.withDbRecovery("StateStore.getDigestById", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  /* ---------- Chat Sessions & Messages ---------- */

  getChatSessions(): ChatSession[] {
    return this.withDbRecovery("StateStore.getChatSessions", (db) => {
      return (db.prepare("SELECT * FROM chat_sessions ORDER BY updatedAt DESC").all() as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          title: row.title as string,
          deviceId: (row.deviceId as string) ?? undefined,
          provider: (row.provider as string) ?? undefined,
          model: (row.model as string) ?? undefined,
          createdAt: row.createdAt as string,
          updatedAt: row.updatedAt as string,
        }),
      );
    });
  }

  getChatSessionById(id: string): ChatSession | null {
    return this.withDbRecovery("StateStore.getChatSessionById", (db) => {
      const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        title: row.title as string,
        deviceId: (row.deviceId as string) ?? undefined,
        provider: (row.provider as string) ?? undefined,
        model: (row.model as string) ?? undefined,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
      };
    });
  }

  getChatMessages(sessionId: string): ChatMessage[] {
    return this.withDbRecovery("StateStore.getChatMessages", (db) => {
      return (db.prepare("SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC").all(sessionId) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          sessionId: row.sessionId as string,
          role: row.role as ChatMessage["role"],
          content: row.content as string,
          provider: (row.provider as string) ?? undefined,
          error: Boolean(row.error),
          createdAt: row.createdAt as string,
          metadata: row.metadata
            ? JSON.parse(row.metadata as string) as ChatMessage["metadata"]
            : undefined,
        }),
      );
    });
  }

  createChatSession(session: ChatSession): void {
    this.withDbRecovery("StateStore.createChatSession", (db) => {
      db.prepare(`
        INSERT INTO chat_sessions (id, title, deviceId, provider, model, createdAt, updatedAt)
        VALUES (@id, @title, @deviceId, @provider, @model, @createdAt, @updatedAt)
      `).run({
        id: session.id,
        title: session.title,
        deviceId: session.deviceId ?? null,
        provider: session.provider ?? null,
        model: session.model ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    });
  }

  addChatMessage(message: ChatMessage): void {
    this.withDbRecovery("StateStore.addChatMessage", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO chat_messages (id, sessionId, role, content, provider, error, createdAt, metadata)
          VALUES (@id, @sessionId, @role, @content, @provider, @error, @createdAt, @metadata)
        `).run({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          provider: message.provider ?? null,
          error: message.error ? 1 : 0,
          createdAt: message.createdAt,
          metadata: JSON.stringify(message.metadata ?? {}),
        });

        // Touch the session's updatedAt
        db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(
          message.createdAt,
          message.sessionId,
        );
      });
      tx();
    });
  }

  updateChatSessionTitle(id: string, title: string): void {
    this.withDbRecovery("StateStore.updateChatSessionTitle", (db) => {
      db.prepare("UPDATE chat_sessions SET title = ?, updatedAt = ? WHERE id = ?").run(
        title,
        new Date().toISOString(),
        id,
      );
    });
  }

  updateChatSessionDevice(id: string, deviceId?: string): void {
    this.withDbRecovery("StateStore.updateChatSessionDevice", (db) => {
      db.prepare("UPDATE chat_sessions SET deviceId = ?, updatedAt = ? WHERE id = ?").run(
        deviceId ?? null,
        new Date().toISOString(),
        id,
      );
    });
  }

  deleteChatSession(id: string): void {
    this.withDbRecovery("StateStore.deleteChatSession", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM chat_messages WHERE sessionId = ?").run(id);
        db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
      });
      tx();
    });
  }

  getDeviceById(id: string): Device | null {
    return this.withDbRecovery("StateStore.getDeviceById", (db) => {
      const row = db.prepare("SELECT * FROM devices WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? deviceFromRow(row) : null;
    });
  }

  /* ---------- Device Adoption ---------- */

  getLatestAdoptionRun(deviceId: string): AdoptionRun | null {
    return this.withDbRecovery("StateStore.getLatestAdoptionRun", (db) => {
      const row = db.prepare(
        "SELECT * FROM adoption_runs WHERE deviceId = ? ORDER BY updatedAt DESC LIMIT 1",
      ).get(deviceId) as Record<string, unknown> | undefined;
      return row ? adoptionRunFromRow(row) : null;
    });
  }

  getAdoptionRunById(id: string): AdoptionRun | null {
    return this.withDbRecovery("StateStore.getAdoptionRunById", (db) => {
      const row = db.prepare("SELECT * FROM adoption_runs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? adoptionRunFromRow(row) : null;
    });
  }

  upsertAdoptionRun(run: AdoptionRun): AdoptionRun {
    return this.withDbRecovery("StateStore.upsertAdoptionRun", (db) => {
      db.prepare(`
        INSERT INTO adoption_runs (id, deviceId, status, stage, profileJson, summary, createdAt, updatedAt)
        VALUES (@id, @deviceId, @status, @stage, @profileJson, @summary, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          deviceId = excluded.deviceId,
          status = excluded.status,
          stage = excluded.stage,
          profileJson = excluded.profileJson,
          summary = excluded.summary,
          createdAt = excluded.createdAt,
          updatedAt = excluded.updatedAt
      `).run({
        id: run.id,
        deviceId: run.deviceId,
        status: run.status,
        stage: run.stage,
        profileJson: JSON.stringify(run.profileJson ?? {}),
        summary: run.summary ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      return run;
    });
  }

  getAdoptionQuestions(
    deviceId: string,
    options?: { runId?: string; unresolvedOnly?: boolean },
  ): AdoptionQuestion[] {
    return this.withDbRecovery("StateStore.getAdoptionQuestions", (db) => {
      const conditions = ["deviceId = @deviceId"];
      const params: Record<string, unknown> = { deviceId };

      if (options?.runId) {
        conditions.push("runId = @runId");
        params.runId = options.runId;
      }
      if (options?.unresolvedOnly) {
        conditions.push("answerJson IS NULL");
      }

      const rows = db.prepare(`
        SELECT * FROM adoption_questions
        WHERE ${conditions.join(" AND ")}
        ORDER BY required DESC, createdAt ASC
      `).all(params) as Record<string, unknown>[];

      return rows.map(adoptionQuestionFromRow);
    });
  }

  deleteAdoptionQuestionsForRun(runId: string): void {
    this.withDbRecovery("StateStore.deleteAdoptionQuestionsForRun", (db) => {
      db.prepare("DELETE FROM adoption_questions WHERE runId = ?").run(runId);
    });
  }

  upsertAdoptionQuestion(question: AdoptionQuestion): AdoptionQuestion {
    return this.withDbRecovery("StateStore.upsertAdoptionQuestion", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO adoption_questions (
          id, runId, deviceId, questionKey, prompt, optionsJson, required, answerJson, answeredAt, createdAt, updatedAt
        )
        VALUES (
          @id, @runId, @deviceId, @questionKey, @prompt, @optionsJson, @required, @answerJson, @answeredAt, @createdAt, @updatedAt
        )
      `).run({
        id: question.id,
        runId: question.runId,
        deviceId: question.deviceId,
        questionKey: question.questionKey,
        prompt: question.prompt,
        optionsJson: JSON.stringify(question.options ?? []),
        required: question.required ? 1 : 0,
        answerJson: question.answerJson ? JSON.stringify(question.answerJson) : null,
        answeredAt: question.answeredAt ?? null,
        createdAt: question.createdAt,
        updatedAt: question.updatedAt,
      });
      return question;
    });
  }

  answerAdoptionQuestion(questionId: string, answerJson: Record<string, unknown>): AdoptionQuestion | null {
    return this.withDbRecovery("StateStore.answerAdoptionQuestion", (db) => {
      const existing = db.prepare("SELECT * FROM adoption_questions WHERE id = ?").get(questionId) as Record<string, unknown> | undefined;
      if (!existing) {
        return null;
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE adoption_questions
        SET answerJson = @answerJson,
            answeredAt = @answeredAt,
            updatedAt = @updatedAt
        WHERE id = @id
      `).run({
        id: questionId,
        answerJson: JSON.stringify(answerJson),
        answeredAt: now,
        updatedAt: now,
      });

      const updated = db.prepare("SELECT * FROM adoption_questions WHERE id = ?").get(questionId) as Record<string, unknown>;
      return adoptionQuestionFromRow(updated);
    });
  }

  /* ---------- Device Credentials ---------- */

  getDeviceCredentials(deviceId: string): DeviceCredential[] {
    return this.withDbRecovery("StateStore.getDeviceCredentials", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_credentials
        WHERE deviceId = ?
        ORDER BY updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceCredentialFromRow);
    });
  }

  getDeviceCredentialById(id: string): DeviceCredential | null {
    return this.withDbRecovery("StateStore.getDeviceCredentialById", (db) => {
      const row = db.prepare("SELECT * FROM device_credentials WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? deviceCredentialFromRow(row) : null;
    });
  }

  upsertDeviceCredential(credential: DeviceCredential): DeviceCredential {
    return this.withDbRecovery("StateStore.upsertDeviceCredential", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_credentials (
          id, deviceId, protocol, adapterId, vaultSecretRef, accountLabel, scopeJson, status, lastValidatedAt, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @protocol, @adapterId, @vaultSecretRef, @accountLabel, @scopeJson, @status, @lastValidatedAt, @createdAt, @updatedAt
        )
      `).run({
        id: credential.id,
        deviceId: credential.deviceId,
        protocol: credential.protocol,
        adapterId: credential.adapterId ?? null,
        vaultSecretRef: credential.vaultSecretRef,
        accountLabel: credential.accountLabel ?? null,
        scopeJson: JSON.stringify(credential.scopeJson ?? {}),
        status: credential.status,
        lastValidatedAt: credential.lastValidatedAt ?? null,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      });
      return credential;
    });
  }

  deleteDeviceCredential(id: string): boolean {
    return this.withDbRecovery("StateStore.deleteDeviceCredential", (db) => {
      const result = db.prepare("DELETE FROM device_credentials WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  getValidatedCredentialProtocols(deviceId: string): string[] {
    return this.withDbRecovery("StateStore.getValidatedCredentialProtocols", (db) => {
      const rows = db.prepare(`
        SELECT DISTINCT protocol
        FROM device_credentials
        WHERE deviceId = ?
          AND status = 'validated'
      `).all(deviceId) as Array<{ protocol: string }>;
      return rows.map((row) => normalizeCredentialProtocol(String(row.protocol)));
    });
  }

  getUsableCredentialProtocols(deviceId: string): string[] {
    return this.withDbRecovery("StateStore.getUsableCredentialProtocols", (db) => {
      const rows = db.prepare(`
        SELECT DISTINCT protocol
        FROM device_credentials
        WHERE deviceId = ?
          AND status IN ('provided', 'validated', 'invalid')
      `).all(deviceId) as Array<{ protocol: string }>;
      return rows.map((row) => String(row.protocol));
    });
  }

  logCredentialAccess(
    entry: Omit<CredentialAccessLog, "id" | "accessedAt"> & { accessedAt?: string },
  ): CredentialAccessLog {
    return this.withAuditDbRecovery("StateStore.logCredentialAccess", (auditDb) => {
      const accessedAt = entry.accessedAt ?? new Date().toISOString();
      const record: CredentialAccessLog = {
        id: randomUUID(),
        credentialId: entry.credentialId,
        deviceId: entry.deviceId,
        protocol: entry.protocol,
        playbookRunId: entry.playbookRunId,
        operationId: entry.operationId,
        adapterId: entry.adapterId,
        actor: entry.actor,
        purpose: entry.purpose,
        result: entry.result,
        details: entry.details ?? {},
        accessedAt,
      };

      auditDb.prepare(`
        INSERT INTO credential_access_events (
          id, credentialId, deviceId, protocol, playbookRunId, operationId, adapterId,
          actor, purpose, result, details, accessedAt, createdAt
        )
        VALUES (
          @id, @credentialId, @deviceId, @protocol, @playbookRunId, @operationId, @adapterId,
          @actor, @purpose, @result, @details, @accessedAt, @createdAt
        )
      `).run({
        id: record.id,
        credentialId: record.credentialId ?? null,
        deviceId: record.deviceId,
        protocol: record.protocol,
        playbookRunId: record.playbookRunId ?? null,
        operationId: record.operationId ?? null,
        adapterId: record.adapterId ?? null,
        actor: record.actor,
        purpose: record.purpose,
        result: record.result,
        details: JSON.stringify(record.details ?? {}),
        accessedAt: record.accessedAt,
        createdAt: record.accessedAt,
      });

      return record;
    });
  }

  /* ---------- Notifications ---------- */

  getNotificationChannels(): NotificationChannel[] {
    return this.withDbRecovery("StateStore.getNotificationChannels", (db) => {
      const rows = db.prepare(`
        SELECT * FROM notification_channels
        ORDER BY enabled DESC, kind ASC, name ASC, updatedAt DESC
      `).all() as Record<string, unknown>[];
      return rows.map(notificationChannelFromRow);
    });
  }

  getNotificationChannelById(id: string): NotificationChannel | null {
    return this.withDbRecovery("StateStore.getNotificationChannelById", (db) => {
      const row = db.prepare("SELECT * FROM notification_channels WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? notificationChannelFromRow(row) : null;
    });
  }

  upsertNotificationChannel(channel: NotificationChannel): NotificationChannel {
    return this.withDbRecovery("StateStore.upsertNotificationChannel", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO notification_channels (
          id, name, kind, enabled, target, eventKinds, minimumSeverity, vaultSecretRef, configJson, createdAt, updatedAt
        )
        VALUES (
          @id, @name, @kind, @enabled, @target, @eventKinds, @minimumSeverity, @vaultSecretRef, @configJson, @createdAt, @updatedAt
        )
      `).run({
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        enabled: channel.enabled ? 1 : 0,
        target: channel.target,
        eventKinds: JSON.stringify(channel.eventKinds ?? []),
        minimumSeverity: channel.minimumSeverity ?? null,
        vaultSecretRef: channel.vaultSecretRef ?? null,
        configJson: JSON.stringify(channel.configJson ?? {}),
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      });
      return channel;
    });
  }

  deleteNotificationChannel(id: string): boolean {
    return this.withDbRecovery("StateStore.deleteNotificationChannel", (db) => {
      const result = db.prepare("DELETE FROM notification_channels WHERE id = ?").run(id);
      return result.changes > 0;
    });
  }

  getNotificationDeliveries(limit = 200): NotificationDelivery[] {
    return this.withDbRecovery("StateStore.getNotificationDeliveries", (db) => {
      const rows = db.prepare(`
        SELECT * FROM notification_deliveries
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(Math.max(1, Math.min(2_000, limit))) as Record<string, unknown>[];
      return rows.map(notificationDeliveryFromRow);
    });
  }

  getNotificationDeliveryById(id: string): NotificationDelivery | null {
    return this.withDbRecovery("StateStore.getNotificationDeliveryById", (db) => {
      const row = db.prepare("SELECT * FROM notification_deliveries WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? notificationDeliveryFromRow(row) : null;
    });
  }

  upsertNotificationDelivery(delivery: NotificationDelivery): NotificationDelivery {
    return this.withDbRecovery("StateStore.upsertNotificationDelivery", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO notification_deliveries (
          id, channelId, eventKind, eventRef, summary, payloadJson, status, attempts,
          lastError, deliveredAt, createdAt, updatedAt
        )
        VALUES (
          @id, @channelId, @eventKind, @eventRef, @summary, @payloadJson, @status, @attempts,
          @lastError, @deliveredAt, @createdAt, @updatedAt
        )
      `).run({
        id: delivery.id,
        channelId: delivery.channelId,
        eventKind: delivery.eventKind,
        eventRef: delivery.eventRef,
        summary: delivery.summary,
        payloadJson: JSON.stringify(delivery.payloadJson ?? {}),
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError ?? null,
        deliveredAt: delivery.deliveredAt ?? null,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
      });
      return delivery;
    });
  }

  /* ---------- Access Methods ---------- */

  getAccessMethods(deviceId: string): AccessMethod[] {
    return this.withDbRecovery("StateStore.getAccessMethods", (db) => {
      const rows = db.prepare(`
        SELECT * FROM access_methods
        WHERE deviceId = ?
        ORDER BY selected DESC, status DESC, kind ASC, COALESCE(port, 0) ASC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(accessMethodFromRow);
    });
  }

  upsertAccessMethod(method: AccessMethod): AccessMethod {
    return this.withDbRecovery("StateStore.upsertAccessMethod", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO access_methods (
          id, deviceId, key, kind, title, protocol, port, secure, selected, status,
          credentialProtocol, summary, metadataJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @key, @kind, @title, @protocol, @port, @secure, @selected, @status,
          @credentialProtocol, @summary, @metadataJson, @createdAt, @updatedAt
        )
      `).run({
        id: method.id,
        deviceId: method.deviceId,
        key: method.key,
        kind: method.kind,
        title: method.title,
        protocol: method.protocol,
        port: method.port ?? null,
        secure: method.secure ? 1 : 0,
        selected: method.selected ? 1 : 0,
        status: method.status,
        credentialProtocol: method.credentialProtocol ?? null,
        summary: method.summary ?? null,
        metadataJson: JSON.stringify(method.metadataJson ?? {}),
        createdAt: method.createdAt,
        updatedAt: method.updatedAt,
      });
      return method;
    });
  }

  clearAccessMethods(deviceId: string): void {
    this.withDbRecovery("StateStore.clearAccessMethods", (db) => {
      db.prepare("DELETE FROM access_methods WHERE deviceId = ?").run(deviceId);
    });
  }

  selectAccessMethods(deviceId: string, keys: string[]): AccessMethod[] {
    return this.withDbRecovery("StateStore.selectAccessMethods", (db) => {
      const normalized = Array.from(new Set(keys.map((value) => String(value).trim()).filter(Boolean)));
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE access_methods
          SET selected = 0, updatedAt = ?
          WHERE deviceId = ?
        `).run(now, deviceId);

        if (normalized.length > 0) {
          const placeholders = normalized.map(() => "?").join(", ");
          db.prepare(`
            UPDATE access_methods
            SET selected = 1, updatedAt = ?
            WHERE deviceId = ? AND key IN (${placeholders})
          `).run(now, deviceId, ...normalized);
        }
      });
      tx();
      return this.getAccessMethods(deviceId);
    });
  }

  /* ---------- Device Profiles ---------- */

  getDeviceProfiles(deviceId: string): DeviceProfileBinding[] {
    return this.withDbRecovery("StateStore.getDeviceProfiles", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_profiles
        WHERE deviceId = ?
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'verified' THEN 1
            WHEN 'selected' THEN 2
            WHEN 'candidate' THEN 3
            ELSE 4
          END,
          confidence DESC,
          updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceProfileBindingFromRow);
    });
  }

  upsertDeviceProfile(binding: DeviceProfileBinding): DeviceProfileBinding {
    return this.withDbRecovery("StateStore.upsertDeviceProfile", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_profiles (
          id, deviceId, profileId, adapterId, name, kind, confidence, status, summary,
          requiredAccessMethods, requiredCredentialProtocols, evidenceJson, draftJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @profileId, @adapterId, @name, @kind, @confidence, @status, @summary,
          @requiredAccessMethods, @requiredCredentialProtocols, @evidenceJson, @draftJson, @createdAt, @updatedAt
        )
      `).run({
        id: binding.id,
        deviceId: binding.deviceId,
        profileId: binding.profileId,
        adapterId: binding.adapterId ?? null,
        name: binding.name,
        kind: binding.kind,
        confidence: binding.confidence,
        status: binding.status,
        summary: binding.summary,
        requiredAccessMethods: JSON.stringify(binding.requiredAccessMethods ?? []),
        requiredCredentialProtocols: JSON.stringify(binding.requiredCredentialProtocols ?? []),
        evidenceJson: JSON.stringify(binding.evidenceJson ?? {}),
        draftJson: JSON.stringify(binding.draftJson ?? {}),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
      return binding;
    });
  }

  clearDeviceProfiles(deviceId: string): void {
    this.withDbRecovery("StateStore.clearDeviceProfiles", (db) => {
      db.prepare("DELETE FROM device_profiles WHERE deviceId = ?").run(deviceId);
    });
  }

  deleteDeviceProfile(deviceId: string, profileId: string): void {
    this.withDbRecovery("StateStore.deleteDeviceProfile", (db) => {
      db.prepare("DELETE FROM device_profiles WHERE deviceId = ? AND profileId = ?").run(deviceId, profileId);
    });
  }

  selectDeviceProfiles(deviceId: string, profileIds: string[]): DeviceProfileBinding[] {
    return this.withDbRecovery("StateStore.selectDeviceProfiles", (db) => {
      const normalized = Array.from(new Set(profileIds.map((value) => String(value).trim()).filter(Boolean)));
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE device_profiles
          SET status = CASE
            WHEN status IN ('active', 'verified') THEN status
            ELSE 'candidate'
          END,
          updatedAt = ?
          WHERE deviceId = ?
        `).run(now, deviceId);

        if (normalized.length > 0) {
          const placeholders = normalized.map(() => "?").join(", ");
          db.prepare(`
            UPDATE device_profiles
            SET status = CASE
              WHEN status IN ('active', 'verified') THEN status
              ELSE 'selected'
            END,
            updatedAt = ?
            WHERE deviceId = ? AND profileId IN (${placeholders})
          `).run(now, deviceId, ...normalized);
        }
      });
      tx();
      return this.getDeviceProfiles(deviceId);
    });
  }

  /* ---------- Access Surfaces ---------- */

  getAccessSurfaces(deviceId: string): AccessSurface[] {
    return this.withDbRecovery("StateStore.getAccessSurfaces", (db) => {
      const rows = db.prepare(`
        SELECT * FROM access_surfaces
        WHERE deviceId = ?
        ORDER BY selected DESC, score DESC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(accessSurfaceFromRow);
    });
  }

  upsertAccessSurface(surface: AccessSurface): AccessSurface {
    return this.withDbRecovery("StateStore.upsertAccessSurface", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO access_surfaces (
          id, deviceId, adapterId, protocol, score, selected, reason, configJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @adapterId, @protocol, @score, @selected, @reason, @configJson, @createdAt, @updatedAt
        )
      `).run({
        id: surface.id,
        deviceId: surface.deviceId,
        adapterId: surface.adapterId,
        protocol: surface.protocol,
        score: surface.score,
        selected: surface.selected ? 1 : 0,
        reason: surface.reason,
        configJson: JSON.stringify(surface.configJson ?? {}),
        createdAt: surface.createdAt,
        updatedAt: surface.updatedAt,
      });
      return surface;
    });
  }

  clearAccessSurfaces(deviceId: string): void {
    this.withDbRecovery("StateStore.clearAccessSurfaces", (db) => {
      db.prepare("DELETE FROM access_surfaces WHERE deviceId = ?").run(deviceId);
    });
  }

  selectAccessSurface(deviceId: string, adapterId: string, protocol: string): void {
    this.withDbRecovery("StateStore.selectAccessSurface", (db) => {
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE access_surfaces
          SET selected = 0, updatedAt = ?
          WHERE deviceId = ? AND protocol = ?
        `).run(now, deviceId, protocol);
        db.prepare(`
          UPDATE access_surfaces
          SET selected = 1, updatedAt = ?
          WHERE deviceId = ? AND adapterId = ? AND protocol = ?
        `).run(now, deviceId, adapterId, protocol);
      });
      tx();
    });
  }

  getDeviceAdapterBindings(deviceId: string): DeviceAdapterBinding[] {
    return this.getAccessSurfaces(deviceId);
  }

  upsertDeviceAdapterBinding(binding: DeviceAdapterBinding): DeviceAdapterBinding {
    return this.upsertAccessSurface(binding);
  }

  clearDeviceAdapterBindings(deviceId: string): void {
    this.clearAccessSurfaces(deviceId);
  }

  selectDeviceAdapterBinding(deviceId: string, adapterId: string, protocol: string): void {
    this.selectAccessSurface(deviceId, adapterId, protocol);
  }

  /* ---------- Workloads ---------- */

  getWorkloads(deviceId: string): Workload[] {
    return this.withDbRecovery("StateStore.getWorkloads", (db) => {
      const rows = db.prepare(`
        SELECT * FROM workloads
        WHERE deviceId = ?
        ORDER BY criticality DESC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(workloadFromRow);
    });
  }

  getWorkloadById(id: string): Workload | null {
    return this.withDbRecovery("StateStore.getWorkloadById", (db) => {
      const row = db.prepare("SELECT * FROM workloads WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? workloadFromRow(row) : null;
    });
  }

  upsertWorkload(workload: Workload): Workload {
    return this.withDbRecovery("StateStore.upsertWorkload", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO workloads (
          id, deviceId, workloadKey, displayName, category, criticality, source, summary, evidenceJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @workloadKey, @displayName, @category, @criticality, @source, @summary, @evidenceJson, @createdAt, @updatedAt
        )
      `).run({
        id: workload.id,
        deviceId: workload.deviceId,
        workloadKey: workload.workloadKey,
        displayName: workload.displayName,
        category: workload.category,
        criticality: workload.criticality,
        source: workload.source,
        summary: workload.summary ?? null,
        evidenceJson: JSON.stringify(workload.evidenceJson ?? {}),
        createdAt: workload.createdAt,
        updatedAt: workload.updatedAt,
      });
      return workload;
    });
  }

  clearWorkloads(deviceId: string): void {
    this.withDbRecovery("StateStore.clearWorkloads", (db) => {
      db.prepare("DELETE FROM workloads WHERE deviceId = ?").run(deviceId);
    });
  }

  deleteWorkload(workloadId: string): void {
    this.withDbRecovery("StateStore.deleteWorkload", (db) => {
      const tx = db.transaction((id: string) => {
        db.prepare("DELETE FROM assurances WHERE workloadId = ?").run(id);
        db.prepare("DELETE FROM workloads WHERE id = ?").run(id);
      });
      tx(workloadId);
    });
  }

  /* ---------- Assurances ---------- */

  getAssurances(deviceId: string): Assurance[] {
    return this.withDbRecovery("StateStore.getAssurances", (db) => {
      const rows = db.prepare(`
        SELECT * FROM assurances
        WHERE deviceId = ?
        ORDER BY criticality DESC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(assuranceFromRow);
    });
  }

  getAssurancesForWorkload(workloadId: string): Assurance[] {
    return this.withDbRecovery("StateStore.getAssurancesForWorkload", (db) => {
      const rows = db.prepare(`
        SELECT * FROM assurances
        WHERE workloadId = ?
        ORDER BY criticality DESC, updatedAt DESC
      `).all(workloadId) as Record<string, unknown>[];
      return rows.map(assuranceFromRow);
    });
  }

  getAssuranceById(id: string): Assurance | null {
    return this.withDbRecovery("StateStore.getAssuranceById", (db) => {
      const row = db.prepare("SELECT * FROM assurances WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? assuranceFromRow(row) : null;
    });
  }

  upsertAssurance(assurance: Assurance): Assurance {
    return this.withDbRecovery("StateStore.upsertAssurance", (db) => {
      const tx = db.transaction((input: Assurance) => {
        const assuranceKey = input.assuranceKey || input.serviceKey || slugifyKey(input.displayName) || input.id;
        const serviceKey = input.serviceKey || assuranceKey;
        const policyJson = input.policyJson ?? input.configJson ?? {};
        const configJson = input.configJson ?? input.policyJson ?? {};
        const requiredProtocols = input.requiredProtocols
          ?? (Array.isArray(policyJson.requiredProtocols)
            ? policyJson.requiredProtocols.map((item) => String(item))
            : []);

        let workloadId = input.workloadId;
        if (!workloadId) {
          const workloadKey = slugifyKey(serviceKey || input.displayName || input.id) || input.id;
          const existing = db.prepare(`
            SELECT * FROM workloads
            WHERE deviceId = ? AND workloadKey = ?
            LIMIT 1
          `).get(input.deviceId, workloadKey) as Record<string, unknown> | undefined;
          if (existing) {
            workloadId = String(existing.id);
          } else {
            workloadId = `workload-${randomUUID()}`;
            db.prepare(`
              INSERT INTO workloads (
                id, deviceId, workloadKey, displayName, category, criticality, source, summary, evidenceJson, createdAt, updatedAt
              )
              VALUES (
                @id, @deviceId, @workloadKey, @displayName, @category, @criticality, @source, @summary, @evidenceJson, @createdAt, @updatedAt
              )
            `).run({
              id: workloadId,
              deviceId: input.deviceId,
              workloadKey,
              displayName: input.displayName,
              category: inferWorkloadCategoryFromText(`${input.displayName} ${serviceKey}`),
              criticality: input.criticality,
              source: "migration",
              summary: input.rationale ?? null,
              evidenceJson: JSON.stringify({
                synthesizedFrom: "assurance",
                assuranceKey,
              }),
              createdAt: input.createdAt,
              updatedAt: input.updatedAt,
            });
          }
        }

        db.prepare(`
          INSERT OR REPLACE INTO assurances (
            id, deviceId, workloadId, assuranceKey, displayName, criticality, desiredState, checkIntervalSec,
            monitorType, requiredProtocols, rationale, configJson, serviceKey, policyJson, createdAt, updatedAt
          )
          VALUES (
            @id, @deviceId, @workloadId, @assuranceKey, @displayName, @criticality, @desiredState, @checkIntervalSec,
            @monitorType, @requiredProtocols, @rationale, @configJson, @serviceKey, @policyJson, @createdAt, @updatedAt
          )
        `).run({
          id: input.id,
          deviceId: input.deviceId,
          workloadId,
          assuranceKey,
          displayName: input.displayName,
          criticality: input.criticality,
          desiredState: input.desiredState,
          checkIntervalSec: input.checkIntervalSec,
          monitorType: input.monitorType ?? null,
          requiredProtocols: JSON.stringify(requiredProtocols),
          rationale: input.rationale ?? null,
          configJson: JSON.stringify(configJson),
          serviceKey,
          policyJson: JSON.stringify(policyJson),
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        });

        return {
          ...input,
          workloadId,
          assuranceKey,
          requiredProtocols,
          configJson,
          serviceKey,
          policyJson,
        } satisfies Assurance;
      });
      return tx(assurance);
    });
  }

  clearAssurances(deviceId: string): void {
    this.withDbRecovery("StateStore.clearAssurances", (db) => {
      db.prepare("DELETE FROM assurances WHERE deviceId = ?").run(deviceId);
    });
  }

  deleteAssurance(id: string): void {
    this.withDbRecovery("StateStore.deleteAssurance", (db) => {
      db.prepare("DELETE FROM assurances WHERE id = ?").run(id);
    });
  }

  appendAssuranceRun(
    run: Omit<AssuranceRun, "id"> & { id?: string },
  ): AssuranceRun {
    return this.withDbRecovery("StateStore.appendAssuranceRun", (db) => {
      const record: AssuranceRun = {
        id: run.id ?? randomUUID(),
        assuranceId: run.assuranceId,
        deviceId: run.deviceId,
        workloadId: run.workloadId,
        status: run.status,
        summary: run.summary,
        evidenceJson: run.evidenceJson ?? {},
        evaluatedAt: run.evaluatedAt,
      };
      db.prepare(`
        INSERT OR REPLACE INTO assurance_runs (
          id, assuranceId, deviceId, workloadId, status, summary, evidenceJson, evaluatedAt
        )
        VALUES (
          @id, @assuranceId, @deviceId, @workloadId, @status, @summary, @evidenceJson, @evaluatedAt
        )
      `).run({
        id: record.id,
        assuranceId: record.assuranceId,
        deviceId: record.deviceId,
        workloadId: record.workloadId ?? null,
        status: record.status,
        summary: record.summary,
        evidenceJson: JSON.stringify(record.evidenceJson ?? {}),
        evaluatedAt: record.evaluatedAt,
      });
      return record;
    });
  }

  getLatestAssuranceRuns(deviceId: string): AssuranceRun[] {
    return this.withDbRecovery("StateStore.getLatestAssuranceRuns", (db) => {
      const rows = db.prepare(`
        SELECT * FROM assurance_runs
        WHERE deviceId = ?
        ORDER BY evaluatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      const latest = new Map<string, AssuranceRun>();
      for (const row of rows) {
        const run = assuranceRunFromRow(row);
        if (!latest.has(run.assuranceId)) {
          latest.set(run.assuranceId, run);
        }
      }
      return Array.from(latest.values()).sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
    });
  }

  /* ---------- Legacy Service Contract Compatibility ---------- */

  getServiceContracts(deviceId: string): ServiceContract[] {
    return this.getAssurances(deviceId);
  }

  upsertServiceContract(contract: ServiceContract): ServiceContract {
    return this.upsertAssurance({
      ...contract,
      assuranceKey: contract.assuranceKey || contract.serviceKey,
      configJson: contract.configJson ?? contract.policyJson ?? {},
      policyJson: contract.policyJson ?? contract.configJson ?? {},
      requiredProtocols: contract.requiredProtocols
        ?? (Array.isArray(contract.policyJson.requiredProtocols)
          ? contract.policyJson.requiredProtocols.map((item) => String(item))
          : []),
    });
  }

  clearServiceContracts(deviceId: string): void {
    this.clearAssurances(deviceId);
  }

  /* ---------- Device Findings ---------- */

  getDeviceFindings(deviceId: string, status?: DeviceFinding["status"]): DeviceFinding[] {
    return this.withDbRecovery("StateStore.getDeviceFindings", (db) => {
      const params: Record<string, unknown> = { deviceId };
      let query = "SELECT * FROM device_findings WHERE deviceId = @deviceId";
      if (status) {
        query += " AND status = @status";
        params.status = status;
      }
      query += " ORDER BY lastSeenAt DESC";
      const rows = db.prepare(query).all(params) as Record<string, unknown>[];
      return rows.map(deviceFindingFromRow);
    });
  }

  upsertDeviceFinding(finding: DeviceFinding): DeviceFinding {
    return this.withDbRecovery("StateStore.upsertDeviceFinding", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_findings (
          id, deviceId, dedupeKey, findingType, severity, title, summary, evidenceJson, status, firstSeenAt, lastSeenAt
        )
        VALUES (
          @id, @deviceId, @dedupeKey, @findingType, @severity, @title, @summary, @evidenceJson, @status, @firstSeenAt, @lastSeenAt
        )
      `).run({
        id: finding.id,
        deviceId: finding.deviceId,
        dedupeKey: finding.dedupeKey,
        findingType: finding.findingType,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        evidenceJson: JSON.stringify(finding.evidenceJson ?? {}),
        status: finding.status,
        firstSeenAt: finding.firstSeenAt,
        lastSeenAt: finding.lastSeenAt,
      });
      return finding;
    });
  }

  upsertDeviceFindingByDedupe(
    finding: Omit<DeviceFinding, "id" | "firstSeenAt" | "lastSeenAt"> & {
      id?: string;
      firstSeenAt?: string;
      lastSeenAt?: string;
    },
  ): DeviceFinding {
    return this.withDbRecovery("StateStore.upsertDeviceFindingByDedupe", (db) => {
      const existing = db.prepare(`
        SELECT * FROM device_findings
        WHERE deviceId = ? AND dedupeKey = ?
        LIMIT 1
      `).get(finding.deviceId, finding.dedupeKey) as Record<string, unknown> | undefined;

      const now = new Date().toISOString();
      const next: DeviceFinding = {
        id: existing?.id ? String(existing.id) : (finding.id ?? randomUUID()),
        deviceId: finding.deviceId,
        dedupeKey: finding.dedupeKey,
        findingType: finding.findingType,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        evidenceJson: finding.evidenceJson,
        status: finding.status,
        firstSeenAt: existing?.firstSeenAt ? String(existing.firstSeenAt) : (finding.firstSeenAt ?? now),
        lastSeenAt: finding.lastSeenAt ?? now,
      };

      db.prepare(`
        INSERT OR REPLACE INTO device_findings (
          id, deviceId, dedupeKey, findingType, severity, title, summary, evidenceJson, status, firstSeenAt, lastSeenAt
        )
        VALUES (
          @id, @deviceId, @dedupeKey, @findingType, @severity, @title, @summary, @evidenceJson, @status, @firstSeenAt, @lastSeenAt
        )
      `).run({
        id: next.id,
        deviceId: next.deviceId,
        dedupeKey: next.dedupeKey,
        findingType: next.findingType,
        severity: next.severity,
        title: next.title,
        summary: next.summary,
        evidenceJson: JSON.stringify(next.evidenceJson ?? {}),
        status: next.status,
        firstSeenAt: next.firstSeenAt,
        lastSeenAt: next.lastSeenAt,
      });

      return next;
    });
  }

  getFindingOccurrences(
    deviceId: string,
    options?: {
      dedupeKey?: string;
      limit?: number;
    },
  ): FindingOccurrence[] {
    return this.withDbRecovery("StateStore.getFindingOccurrences", (db) => {
      const params: Array<string | number> = [deviceId];
      let query = `
        SELECT *
        FROM finding_occurrences
        WHERE deviceId = ?
      `;
      if (options?.dedupeKey) {
        query += " AND dedupeKey = ?";
        params.push(options.dedupeKey);
      }
      query += " ORDER BY observedAt DESC LIMIT ?";
      params.push(Math.max(1, Math.min(500, options?.limit ?? 100)));
      const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
      return rows.map(findingOccurrenceFromRow);
    });
  }

  appendFindingOccurrence(occurrence: FindingOccurrence): FindingOccurrence {
    return this.withDbRecovery("StateStore.appendFindingOccurrence", (db) => {
      db.prepare(`
        INSERT INTO finding_occurrences (
          id, findingId, deviceId, dedupeKey, findingType, severity, status, summary, evidenceJson, source, observedAt, metadataJson
        )
        VALUES (
          @id, @findingId, @deviceId, @dedupeKey, @findingType, @severity, @status, @summary, @evidenceJson, @source, @observedAt, @metadataJson
        )
      `).run({
        id: occurrence.id,
        findingId: occurrence.findingId ?? null,
        deviceId: occurrence.deviceId,
        dedupeKey: occurrence.dedupeKey,
        findingType: occurrence.findingType,
        severity: occurrence.severity,
        status: occurrence.status,
        summary: occurrence.summary,
        evidenceJson: JSON.stringify(occurrence.evidenceJson ?? {}),
        source: occurrence.source,
        observedAt: occurrence.observedAt,
        metadataJson: JSON.stringify(occurrence.metadataJson ?? {}),
      });

      db.prepare(`
        DELETE FROM finding_occurrences
        WHERE id NOT IN (
          SELECT id FROM finding_occurrences
          ORDER BY observedAt DESC
          LIMIT 5000
        )
      `).run();

      return occurrence;
    });
  }

  /* ---------- Dashboard Widget Pages ---------- */

  private buildDashboardWidgetPageSlug(
    db: Database.Database,
    name: string,
    pageIdToIgnore?: string,
  ): string {
    const base = slugifyKey(name) || "widget-page";
    let candidate = base;
    let suffix = 2;

    while (true) {
      const existing = db.prepare(`
        SELECT id FROM dashboard_widget_pages
        WHERE slug = ?
        LIMIT 1
      `).get(candidate) as { id?: string } | undefined;
      if (!existing || existing.id === pageIdToIgnore) {
        return candidate;
      }
      const suffixText = `-${suffix++}`;
      candidate = `${base.slice(0, Math.max(1, 64 - suffixText.length))}${suffixText}`;
    }
  }

  private readDashboardWidgetInventory(db: Database.Database): DashboardWidgetInventoryEntry[] {
    const rows = db.prepare(`
      SELECT
        w.id AS widgetId,
        w.deviceId AS deviceId,
        COALESCE(NULLIF(d.name, ''), NULLIF(d.hostname, ''), w.deviceId) AS deviceName,
        d.ip AS deviceIp,
        d.status AS deviceStatus,
        w.slug AS widgetSlug,
        w.name AS widgetName,
        w.description AS widgetDescription,
        w.status AS widgetStatus,
        w.revision AS widgetRevision,
        w.capabilitiesJson AS capabilitiesJson,
        w.updatedAt AS widgetUpdatedAt
      FROM device_widgets w
      INNER JOIN devices d ON d.id = w.deviceId
      ORDER BY LOWER(COALESCE(NULLIF(d.name, ''), NULLIF(d.hostname, ''), w.deviceId)) ASC,
        w.updatedAt DESC,
        LOWER(w.name) ASC
    `).all() as Record<string, unknown>[];

    return rows.map(dashboardWidgetInventoryEntryFromRow);
  }

  private readDashboardWidgetPageItemRecords(
    db: Database.Database,
    pageId: string,
  ): DashboardWidgetPageItemRecord[] {
    return (db.prepare(`
      SELECT
        id,
        pageId,
        widgetId,
        title,
        columnStart,
        columnSpan,
        rowStart,
        rowSpan,
        sortOrder,
        createdAt,
        updatedAt
      FROM dashboard_widget_page_items
      WHERE pageId = ?
      ORDER BY rowStart ASC, columnStart ASC, sortOrder ASC, createdAt ASC
    `).all(pageId) as Record<string, unknown>[]).map(dashboardWidgetPageItemRecordFromRow);
  }

  private persistDashboardWidgetPageItemLayout(
    db: Database.Database,
    items: DashboardWidgetPageItemRecord[],
  ): void {
    const update = db.prepare(`
      UPDATE dashboard_widget_page_items
      SET title = @title,
        columnStart = @columnStart,
        columnSpan = @columnSpan,
        rowStart = @rowStart,
        rowSpan = @rowSpan,
        sortOrder = @sortOrder,
        updatedAt = @updatedAt
      WHERE id = @id
    `);

    items.forEach((record) => {
      update.run({
        id: record.id,
        title: record.title?.trim() ? record.title.trim() : null,
        columnStart: record.columnStart,
        columnSpan: record.columnSpan,
        rowStart: record.rowStart,
        rowSpan: record.rowSpan,
        sortOrder: record.sortOrder,
        updatedAt: record.updatedAt,
      });
    });
  }

  private readDashboardWidgetPages(db: Database.Database): DashboardWidgetPage[] {
    const pages = (db.prepare(`
      SELECT * FROM dashboard_widget_pages
      ORDER BY sortOrder ASC, updatedAt DESC, createdAt ASC
    `).all() as Record<string, unknown>[]).map((row) => ({
      ...dashboardWidgetPageRecordFromRow(row),
      items: [] as DashboardWidgetPageItem[],
    }));

    if (pages.length === 0) {
      return [];
    }

    const pageMap = new Map(pages.map((page) => [page.id, page]));
    const itemRows = db.prepare(`
      SELECT
        i.id,
        i.pageId,
        i.widgetId,
        i.title,
        i.columnStart,
        i.columnSpan,
        i.rowStart,
        i.rowSpan,
        i.sortOrder,
        i.createdAt,
        i.updatedAt,
        w.deviceId AS deviceId,
        COALESCE(NULLIF(d.name, ''), NULLIF(d.hostname, ''), w.deviceId) AS deviceName,
        d.ip AS deviceIp,
        d.status AS deviceStatus,
        w.slug AS widgetSlug,
        w.name AS widgetName,
        w.description AS widgetDescription,
        w.status AS widgetStatus,
        w.revision AS widgetRevision,
        w.capabilitiesJson AS capabilitiesJson,
        w.updatedAt AS widgetUpdatedAt
      FROM dashboard_widget_page_items i
      INNER JOIN device_widgets w ON w.id = i.widgetId
      INNER JOIN devices d ON d.id = w.deviceId
      ORDER BY i.pageId ASC, i.rowStart ASC, i.columnStart ASC, i.sortOrder ASC, i.createdAt ASC
    `).all() as Record<string, unknown>[];

    for (const row of itemRows) {
      const page = pageMap.get(String(row.pageId));
      if (!page) {
        continue;
      }
      page.items.push(dashboardWidgetPageItemFromRow(row));
    }

    return pages.map((page) => ({
      ...page,
      items: resolveDashboardWidgetGridLayout(page.items),
    }));
  }

  getDashboardWidgetInventory(): DashboardWidgetInventoryEntry[] {
    return this.withDbRecovery("StateStore.getDashboardWidgetInventory", (db) => (
      this.readDashboardWidgetInventory(db)
    ));
  }

  getDashboardWidgetPages(db?: Database.Database): DashboardWidgetPage[] {
    if (db) {
      return this.readDashboardWidgetPages(db);
    }
    return this.withDbRecovery("StateStore.getDashboardWidgetPages", (database) => (
      this.readDashboardWidgetPages(database)
    ));
  }

  getDashboardWidgetPageById(pageId: string): DashboardWidgetPage | null {
    return this.withDbRecovery("StateStore.getDashboardWidgetPageById", (db) => (
      this.readDashboardWidgetPages(db).find((page) => page.id === pageId) ?? null
    ));
  }

  createDashboardWidgetPage(input: {
    id: string;
    name: string;
    sortOrder?: number;
    createdAt: string;
    updatedAt?: string;
  }): DashboardWidgetPage {
    return this.withDbRecovery("StateStore.createDashboardWidgetPage", (db) => {
      const name = input.name.trim() || "Widget page";
      const sortOrder = Number.isFinite(Number(input.sortOrder))
        ? Number(input.sortOrder)
        : Number(
          (db.prepare("SELECT COALESCE(MAX(sortOrder), -1) + 1 AS sortOrder FROM dashboard_widget_pages").get() as {
            sortOrder?: number;
          }).sortOrder ?? 0,
        );
      const record: DashboardWidgetPageRecord = {
        id: input.id,
        slug: this.buildDashboardWidgetPageSlug(db, name),
        name,
        sortOrder,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt ?? input.createdAt,
      };

      db.prepare(`
        INSERT INTO dashboard_widget_pages (
          id, slug, name, sortOrder, createdAt, updatedAt
        )
        VALUES (
          @id, @slug, @name, @sortOrder, @createdAt, @updatedAt
        )
      `).run(record);

      return this.readDashboardWidgetPages(db).find((page) => page.id === record.id) ?? { ...record, items: [] };
    });
  }

  updateDashboardWidgetPage(
    pageId: string,
    updates: {
      name?: string;
      sortOrder?: number;
    },
  ): DashboardWidgetPage | null {
    return this.withDbRecovery("StateStore.updateDashboardWidgetPage", (db) => {
      const existingRow = db.prepare(`
        SELECT * FROM dashboard_widget_pages
        WHERE id = ?
        LIMIT 1
      `).get(pageId) as Record<string, unknown> | undefined;

      if (!existingRow) {
        return null;
      }

      const existing = dashboardWidgetPageRecordFromRow(existingRow);
      const next: DashboardWidgetPageRecord = {
        ...existing,
        name: typeof updates.name === "string" ? updates.name.trim() || existing.name : existing.name,
        sortOrder: Number.isFinite(Number(updates.sortOrder)) ? Number(updates.sortOrder) : existing.sortOrder,
        updatedAt: new Date().toISOString(),
      };

      db.prepare(`
        UPDATE dashboard_widget_pages
        SET name = @name,
          sortOrder = @sortOrder,
          updatedAt = @updatedAt
        WHERE id = @id
      `).run(next);

      return this.readDashboardWidgetPages(db).find((page) => page.id === pageId) ?? null;
    });
  }

  deleteDashboardWidgetPage(pageId: string): boolean {
    return this.withDbRecovery("StateStore.deleteDashboardWidgetPage", (db) => {
      const result = db.prepare("DELETE FROM dashboard_widget_pages WHERE id = ?").run(pageId);
      return result.changes > 0;
    });
  }

  addDashboardWidgetPageItem(input: {
    id: string;
    pageId: string;
    widgetId: string;
    title?: string;
    columnStart?: number;
    columnSpan?: number;
    rowStart?: number;
    rowSpan?: number;
    createdAt: string;
    updatedAt?: string;
  }): DashboardWidgetPage | null {
    return this.withDbRecovery("StateStore.addDashboardWidgetPageItem", (db) => {
      const pageExists = db.prepare("SELECT 1 FROM dashboard_widget_pages WHERE id = ? LIMIT 1").get(input.pageId);
      const widgetExists = db.prepare("SELECT 1 FROM device_widgets WHERE id = ? LIMIT 1").get(input.widgetId);
      if (!pageExists || !widgetExists) {
        return null;
      }

      const existingItems = this.readDashboardWidgetPageItemRecords(db, input.pageId);
      const columnSpan = normalizeDashboardWidgetColumnSpan(input.columnSpan ?? 6);
      const rowSpan = normalizeDashboardWidgetRowSpan(input.rowSpan ?? 4);
      const placement = typeof input.columnStart === "number" && typeof input.rowStart === "number"
        ? {
          columnStart: input.columnStart,
          rowStart: input.rowStart,
        }
        : findDashboardWidgetGridPlacement(existingItems, columnSpan, rowSpan);
      const nextItem: DashboardWidgetPageItemRecord = {
        id: input.id,
        pageId: input.pageId,
        widgetId: input.widgetId,
        title: input.title?.trim() ? input.title.trim() : undefined,
        columnStart: placement.columnStart,
        columnSpan,
        rowStart: placement.rowStart,
        rowSpan,
        sortOrder: existingItems.length,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt ?? input.createdAt,
      };
      const nextItems = resolveDashboardWidgetGridLayout(
        [...existingItems, nextItem],
        [nextItem.id],
      ).map((item) => ({
        ...item,
        pageId: item.pageId,
        widgetId: item.widgetId,
        title: item.title,
        updatedAt: item.id === nextItem.id ? nextItem.updatedAt : item.updatedAt,
      }));

      const insertedItem = nextItems.find((item) => item.id === nextItem.id) ?? nextItem;

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO dashboard_widget_page_items (
            id, pageId, widgetId, title, columnStart, columnSpan, rowStart, rowSpan, sortOrder, createdAt, updatedAt
          )
          VALUES (
            @id, @pageId, @widgetId, @title, @columnStart, @columnSpan, @rowStart, @rowSpan, @sortOrder, @createdAt, @updatedAt
          )
        `).run({
          id: insertedItem.id,
          pageId: insertedItem.pageId,
          widgetId: insertedItem.widgetId,
          title: insertedItem.title ?? null,
          columnStart: insertedItem.columnStart,
          columnSpan: insertedItem.columnSpan,
          rowStart: insertedItem.rowStart,
          rowSpan: insertedItem.rowSpan,
          sortOrder: insertedItem.sortOrder,
          createdAt: insertedItem.createdAt,
          updatedAt: insertedItem.updatedAt,
        });
        this.persistDashboardWidgetPageItemLayout(db, nextItems);
      });
      tx();

      return this.readDashboardWidgetPages(db).find((page) => page.id === input.pageId) ?? null;
    });
  }

  updateDashboardWidgetPageItem(
    itemId: string,
    updates: {
      title?: string | null;
      columnStart?: number;
      columnSpan?: number;
      rowStart?: number;
      rowSpan?: number;
      sortOrder?: number;
    },
  ): DashboardWidgetPage | null {
    return this.withDbRecovery("StateStore.updateDashboardWidgetPageItem", (db) => {
      const existing = db.prepare(`
        SELECT * FROM dashboard_widget_page_items
        WHERE id = ?
        LIMIT 1
      `).get(itemId) as Record<string, unknown> | undefined;

      if (!existing) {
        return null;
      }

      const pageId = String(existing.pageId);
      const pageItems = this.readDashboardWidgetPageItemRecords(db, pageId);
      const nextUpdatedAt = new Date().toISOString();
      const title = typeof updates.title === "undefined"
        ? (existing.title ? String(existing.title) : undefined)
        : (typeof updates.title === "string" && updates.title.trim().length > 0 ? updates.title.trim() : undefined);
      const currentColumnSpan = normalizeDashboardWidgetColumnSpan(Number(existing.columnSpan ?? 6));
      const currentRowSpan = normalizeDashboardWidgetRowSpan(Number(existing.rowSpan ?? 4));
      const nextColumnSpan = typeof updates.columnSpan === "undefined"
        ? currentColumnSpan
        : normalizeDashboardWidgetColumnSpan(updates.columnSpan);
      const nextRowSpan = typeof updates.rowSpan === "undefined"
        ? currentRowSpan
        : normalizeDashboardWidgetRowSpan(updates.rowSpan);
      const nextItems = pageItems.map((item) => (
        item.id === itemId
          ? {
            ...item,
            title,
            columnStart: typeof updates.columnStart === "undefined"
              ? Number(existing.columnStart ?? item.columnStart ?? 1)
              : updates.columnStart,
            columnSpan: nextColumnSpan,
            rowStart: typeof updates.rowStart === "undefined"
              ? Number(existing.rowStart ?? item.rowStart ?? 1)
              : updates.rowStart,
            rowSpan: nextRowSpan,
            sortOrder: Number.isFinite(Number(updates.sortOrder))
              ? Math.max(0, Math.round(Number(updates.sortOrder)))
              : item.sortOrder,
            updatedAt: nextUpdatedAt,
          }
          : item
      ));
      const shouldResolveLayout = typeof updates.columnStart !== "undefined"
        || typeof updates.columnSpan !== "undefined"
        || typeof updates.rowStart !== "undefined"
        || typeof updates.rowSpan !== "undefined"
        || typeof updates.sortOrder !== "undefined";
      const persistedItems = shouldResolveLayout
        ? resolveDashboardWidgetGridLayout(nextItems, [itemId]).map((item) => ({
          ...item,
          updatedAt: item.id === itemId || item.updatedAt === nextUpdatedAt ? nextUpdatedAt : item.updatedAt,
        }))
        : nextItems;

      db.transaction((items: DashboardWidgetPageItemRecord[]) => {
        this.persistDashboardWidgetPageItemLayout(db, items);
      })(persistedItems);

      return this.readDashboardWidgetPages(db).find((page) => page.id === pageId) ?? null;
    });
  }

  reorderDashboardWidgetPageItems(pageId: string, itemIds: string[]): DashboardWidgetPage | null {
    return this.withDbRecovery("StateStore.reorderDashboardWidgetPageItems", (db) => {
      const existingRows = db.prepare(`
        SELECT id FROM dashboard_widget_page_items
        WHERE pageId = ?
        ORDER BY sortOrder ASC, createdAt ASC
      `).all(pageId) as Array<{ id: string }>;

      if (existingRows.length === 0) {
        return this.readDashboardWidgetPages(db).find((page) => page.id === pageId) ?? null;
      }

      const existingIds = existingRows.map((row) => String(row.id));
      const requestedIds = itemIds.filter((id, index) => existingIds.includes(id) && itemIds.indexOf(id) === index);
      const orderedIds = [...requestedIds, ...existingIds.filter((id) => !requestedIds.includes(id))];
      const updatedAt = new Date().toISOString();
      const update = db.prepare(`
        UPDATE dashboard_widget_page_items
        SET sortOrder = ?, updatedAt = ?
        WHERE id = ?
      `);

      const tx = db.transaction(() => {
        orderedIds.forEach((id, index) => {
          update.run(index, updatedAt, id);
        });
      });
      tx();

      return this.readDashboardWidgetPages(db).find((page) => page.id === pageId) ?? null;
    });
  }

  deleteDashboardWidgetPageItem(itemId: string): { pageId: string; page: DashboardWidgetPage | null } | null {
    return this.withDbRecovery("StateStore.deleteDashboardWidgetPageItem", (db) => {
      const existing = db.prepare(`
        SELECT pageId FROM dashboard_widget_page_items
        WHERE id = ?
        LIMIT 1
      `).get(itemId) as { pageId?: string } | undefined;

      if (!existing?.pageId) {
        return null;
      }

      db.prepare("DELETE FROM dashboard_widget_page_items WHERE id = ?").run(itemId);

      return {
        pageId: existing.pageId,
        page: this.readDashboardWidgetPages(db).find((candidate) => candidate.id === existing.pageId) ?? null,
      };
    });
  }

  /* ---------- Device Widgets ---------- */

  getDeviceWidgets(deviceId: string): DeviceWidget[] {
    return this.withDbRecovery("StateStore.getDeviceWidgets", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_widgets
        WHERE deviceId = ?
        ORDER BY updatedAt DESC, createdAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceWidgetFromRow);
    });
  }

  getDeviceWidgetById(widgetId: string): DeviceWidget | null {
    return this.withDbRecovery("StateStore.getDeviceWidgetById", (db) => {
      const row = db.prepare("SELECT * FROM device_widgets WHERE id = ? LIMIT 1").get(widgetId) as Record<string, unknown> | undefined;
      return row ? deviceWidgetFromRow(row) : null;
    });
  }

  getDeviceWidgetBySlug(deviceId: string, slug: string): DeviceWidget | null {
    return this.withDbRecovery("StateStore.getDeviceWidgetBySlug", (db) => {
      const row = db.prepare(`
        SELECT * FROM device_widgets
        WHERE deviceId = ? AND slug = ?
        LIMIT 1
      `).get(deviceId, slug) as Record<string, unknown> | undefined;
      return row ? deviceWidgetFromRow(row) : null;
    });
  }

  upsertDeviceWidget(widget: DeviceWidget): DeviceWidget {
    return this.withDbRecovery("StateStore.upsertDeviceWidget", (db) => {
      const existing = db.prepare("SELECT revision FROM device_widgets WHERE id = ? LIMIT 1").get(widget.id) as { revision?: number } | undefined;
      const revision = existing?.revision
        ? Math.max(Number(existing.revision) + 1, Number(widget.revision ?? 1))
        : Math.max(1, Number(widget.revision ?? 1));

      const next: DeviceWidget = {
        ...widget,
        description: normalizeWidgetDescription(widget.description),
        revision,
      };

      db.prepare(`
        INSERT OR REPLACE INTO device_widgets (
          id, deviceId, slug, name, description, status, html, css, js, capabilitiesJson,
          controlsJson, sourcePrompt, createdBy, revision, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @slug, @name, @description, @status, @html, @css, @js, @capabilitiesJson,
          @controlsJson, @sourcePrompt, @createdBy, @revision, @createdAt, @updatedAt
        )
      `).run({
        id: next.id,
        deviceId: next.deviceId,
        slug: next.slug,
        name: next.name,
        description: next.description ?? null,
        status: next.status,
        html: next.html,
        css: next.css,
        js: next.js,
        capabilitiesJson: JSON.stringify(next.capabilities ?? []),
        controlsJson: JSON.stringify(next.controls ?? []),
        sourcePrompt: next.sourcePrompt ?? null,
        createdBy: next.createdBy,
        revision: next.revision,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      });

      return next;
    });
  }

  deleteDeviceWidget(widgetId: string): boolean {
    return this.withDbRecovery("StateStore.deleteDeviceWidget", (db) => {
      const result = db.prepare("DELETE FROM device_widgets WHERE id = ?").run(widgetId);
      return result.changes > 0;
    });
  }

  getDeviceWidgetRuntimeState(widgetId: string): DeviceWidgetRuntimeState | null {
    return this.withDbRecovery("StateStore.getDeviceWidgetRuntimeState", (db) => {
      const row = db.prepare(`
        SELECT * FROM device_widget_state
        WHERE widgetId = ?
        LIMIT 1
      `).get(widgetId) as Record<string, unknown> | undefined;
      return row ? deviceWidgetRuntimeStateFromRow(row) : null;
    });
  }

  upsertDeviceWidgetRuntimeState(state: DeviceWidgetRuntimeState): DeviceWidgetRuntimeState {
    return this.withDbRecovery("StateStore.upsertDeviceWidgetRuntimeState", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_widget_state (
          widgetId, deviceId, stateJson, updatedAt
        )
        VALUES (
          @widgetId, @deviceId, @stateJson, @updatedAt
        )
      `).run({
        widgetId: state.widgetId,
        deviceId: state.deviceId,
        stateJson: JSON.stringify(state.stateJson ?? {}),
        updatedAt: state.updatedAt,
      });
      return state;
    });
  }

  getDeviceWidgetOperationRuns(widgetId: string, limit = 20): DeviceWidgetOperationRun[] {
    return this.withDbRecovery("StateStore.getDeviceWidgetOperationRuns", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_widget_operation_runs
        WHERE widgetId = ?
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(widgetId, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
      return rows.map(deviceWidgetOperationRunFromRow);
    });
  }

  getDeviceWidgetOperationRunsForDevice(deviceId: string, limit = 20): DeviceWidgetOperationRun[] {
    return this.withDbRecovery("StateStore.getDeviceWidgetOperationRunsForDevice", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_widget_operation_runs
        WHERE deviceId = ?
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(deviceId, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
      return rows.map(deviceWidgetOperationRunFromRow);
    });
  }

  addDeviceWidgetOperationRun(run: DeviceWidgetOperationRun): DeviceWidgetOperationRun {
    return this.withDbRecovery("StateStore.addDeviceWidgetOperationRun", (db) => {
      const tx = db.transaction((next: DeviceWidgetOperationRun) => {
        db.prepare(`
          INSERT INTO device_widget_operation_runs (
            id, widgetId, deviceId, widgetRevision, operationKind, operationMode, brokerProtocol,
            status, phase, proof, approvalRequired, policyDecision, policyReason, approved,
            idempotencyKey, summary, output, operationJson, detailsJson, createdAt
          )
          VALUES (
            @id, @widgetId, @deviceId, @widgetRevision, @operationKind, @operationMode, @brokerProtocol,
            @status, @phase, @proof, @approvalRequired, @policyDecision, @policyReason, @approved,
            @idempotencyKey, @summary, @output, @operationJson, @detailsJson, @createdAt
          )
        `).run({
          id: next.id,
          widgetId: next.widgetId,
          deviceId: next.deviceId,
          widgetRevision: next.widgetRevision,
          operationKind: next.operationKind,
          operationMode: next.operationMode,
          brokerProtocol: next.brokerProtocol ?? null,
          status: next.status,
          phase: next.phase,
          proof: next.proof,
          approvalRequired: next.approvalRequired ? 1 : 0,
          policyDecision: next.policyDecision,
          policyReason: next.policyReason,
          approved: next.approved ? 1 : 0,
          idempotencyKey: next.idempotencyKey,
          summary: next.summary,
          output: next.output,
          operationJson: JSON.stringify(next.operationJson ?? {}),
          detailsJson: JSON.stringify(next.detailsJson ?? {}),
          createdAt: next.createdAt,
        });

        db.prepare(`
          DELETE FROM device_widget_operation_runs
          WHERE widgetId = ?
            AND id NOT IN (
              SELECT id FROM device_widget_operation_runs
              WHERE widgetId = ?
              ORDER BY createdAt DESC
              LIMIT 250
            )
        `).run(next.widgetId, next.widgetId);
      });

      tx(run);
      return run;
    });
  }

  getDeviceAutomations(deviceId: string): DeviceAutomation[] {
    return this.withDbRecovery("StateStore.getDeviceAutomations", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_automations
        WHERE deviceId = ?
        ORDER BY updatedAt DESC, createdAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceAutomationFromRow);
    });
  }

  getDeviceAutomationById(automationId: string): DeviceAutomation | null {
    return this.withDbRecovery("StateStore.getDeviceAutomationById", (db) => {
      const row = db.prepare(`
        SELECT * FROM device_automations
        WHERE id = ?
        LIMIT 1
      `).get(automationId) as Record<string, unknown> | undefined;
      return row ? deviceAutomationFromRow(row) : null;
    });
  }

  getDueDeviceAutomations(nowIso: string, limit = 50): DeviceAutomation[] {
    return this.withDbRecovery("StateStore.getDueDeviceAutomations", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_automations
        WHERE enabled = 1
          AND scheduleKind != 'manual'
          AND nextRunAt IS NOT NULL
          AND nextRunAt <= ?
        ORDER BY nextRunAt ASC, updatedAt ASC
        LIMIT ?
      `).all(nowIso, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
      return rows.map(deviceAutomationFromRow);
    });
  }

  upsertDeviceAutomation(automation: DeviceAutomation): DeviceAutomation {
    return this.withDbRecovery("StateStore.upsertDeviceAutomation", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_automations (
          id, deviceId, targetKind, widgetId, controlId, targetJson, name, description, enabled, scheduleKind,
          intervalMinutes, hourLocal, minuteLocal, inputJson, lastRunAt, nextRunAt, lastRunStatus,
          lastRunSummary, createdBy, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @targetKind, @widgetId, @controlId, @targetJson, @name, @description, @enabled, @scheduleKind,
          @intervalMinutes, @hourLocal, @minuteLocal, @inputJson, @lastRunAt, @nextRunAt, @lastRunStatus,
          @lastRunSummary, @createdBy, @createdAt, @updatedAt
        )
      `).run({
        id: automation.id,
        deviceId: automation.deviceId,
        targetKind: automation.targetKind,
        widgetId: automation.widgetId,
        controlId: automation.controlId,
        targetJson: JSON.stringify(automation.targetJson ?? {}),
        name: automation.name,
        description: automation.description ?? null,
        enabled: automation.enabled ? 1 : 0,
        scheduleKind: automation.scheduleKind,
        intervalMinutes: automation.intervalMinutes ?? null,
        hourLocal: automation.hourLocal ?? null,
        minuteLocal: automation.minuteLocal ?? null,
        inputJson: JSON.stringify(automation.inputJson ?? {}),
        lastRunAt: automation.lastRunAt ?? null,
        nextRunAt: automation.nextRunAt ?? null,
        lastRunStatus: automation.lastRunStatus ?? null,
        lastRunSummary: automation.lastRunSummary ?? null,
        createdBy: automation.createdBy,
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
      });
      return automation;
    });
  }

  deleteDeviceAutomation(automationId: string): boolean {
    return this.withDbRecovery("StateStore.deleteDeviceAutomation", (db) => {
      const result = db.prepare("DELETE FROM device_automations WHERE id = ?").run(automationId);
      return result.changes > 0;
    });
  }

  getDeviceAutomationRuns(automationId: string, limit = 20): DeviceAutomationRun[] {
    return this.withDbRecovery("StateStore.getDeviceAutomationRuns", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_automation_runs
        WHERE automationId = ?
        ORDER BY createdAt DESC
        LIMIT ?
      `).all(automationId, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
      return rows.map(deviceAutomationRunFromRow);
    });
  }

  addDeviceAutomationRun(run: DeviceAutomationRun): DeviceAutomationRun {
    return this.withDbRecovery("StateStore.addDeviceAutomationRun", (db) => {
      const tx = db.transaction((next: DeviceAutomationRun) => {
        db.prepare(`
          INSERT INTO device_automation_runs (
            id, automationId, deviceId, widgetId, controlId, status, summary, resultJson, createdAt, completedAt
          )
          VALUES (
            @id, @automationId, @deviceId, @widgetId, @controlId, @status, @summary, @resultJson, @createdAt, @completedAt
          )
        `).run({
          id: next.id,
          automationId: next.automationId,
          deviceId: next.deviceId,
          widgetId: next.widgetId,
          controlId: next.controlId,
          status: next.status,
          summary: next.summary,
          resultJson: JSON.stringify(next.resultJson ?? {}),
          createdAt: next.createdAt,
          completedAt: next.completedAt ?? null,
        });

        db.prepare(`
          DELETE FROM device_automation_runs
          WHERE automationId = ?
            AND id NOT IN (
              SELECT id FROM device_automation_runs
              WHERE automationId = ?
              ORDER BY createdAt DESC
              LIMIT 250
            )
        `).run(next.automationId, next.automationId);
      });

      tx(run);
      return run;
    });
  }

  getDataDir(): string {
    return dbGetDataDir();
  }

  getStateFile(): string {
    return getDbPath();
  }

  getAuditStateFile(): string {
    return getAuditDbPath();
  }
}

export const stateStore = new StateStore();
