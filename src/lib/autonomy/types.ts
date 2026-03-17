export type PackKind = "builtin" | "managed";
export type PackTrustMode = "builtin" | "verified" | "unsigned";
export type PackVerificationStatus = "builtin" | "verified" | "unsigned" | "failed";
export type PackResourceType =
  | "subagent"
  | "mission-template"
  | "workload-template"
  | "assurance-template"
  | "finding-template"
  | "investigation-heuristic"
  | "playbook"
  | "briefing-template"
  | "report-template"
  | "gateway-template"
  | "adapter"
  | "tool"
  | "lab";

export interface PackCompatibility {
  minimumVersion?: string;
  maximumVersion?: string;
}

export interface PackManifestResource {
  type: PackResourceType;
  key: string;
  title: string;
  description?: string;
}

export interface PackManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  resources: PackManifestResource[];
  tags?: string[];
  stewardCompatibility?: PackCompatibility;
}

export interface PackRecord {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  kind: PackKind;
  enabled: boolean;
  builtin: boolean;
  trustMode: PackTrustMode;
  signerId?: string;
  signature?: string;
  signatureAlgorithm?: string;
  verificationStatus: PackVerificationStatus;
  verifiedAt?: string;
  manifestJson: PackManifest;
  installedAt: string;
  updatedAt: string;
}

export interface PackSignerRecord {
  id: string;
  slug: string;
  name: string;
  publicKeyPem: string;
  algorithm: "ed25519";
  trustScope: "builtin" | "trusted" | "community";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PackResourceRecord {
  id: string;
  packId: string;
  type: PackResourceType;
  resourceKey: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type PackVersionAction = "installed" | "upgraded" | "removed";

export interface PackVersionRecord {
  id: string;
  packId: string;
  version: string;
  action: PackVersionAction;
  manifestJson: PackManifest;
  createdAt: string;
}

export type SubagentStatus = "active" | "paused" | "disabled";
export type SubagentDomain =
  | "availability"
  | "certificates"
  | "backups"
  | "storage"
  | "network"
  | "briefing"
  | "general";

export type SubagentApprovalMode =
  | "observe_only"
  | "approval_required"
  | "safe_autonomy"
  | "full_autonomy";

export interface SubagentScope {
  domain: SubagentDomain;
  missionKinds?: MissionKind[];
  deviceTypes?: string[];
  workloadCategories?: string[];
  ownsCapabilities?: string[];
  ownsDeviceReachability?: boolean;
  ownsTlsLifecycle?: boolean;
  ownsBackupState?: boolean;
  ownsDiskHealth?: boolean;
  ownsNetworkHealth?: boolean;
  ownsBriefings?: boolean;
}

export interface SubagentAutonomyPolicy {
  urgency?: "low" | "medium" | "high";
  approvalMode: SubagentApprovalMode;
  allowedMissionKinds: MissionKind[];
  channelVoice: string;
  operatingPrinciples: string[];
  autonomyBudget: {
    maxActionsPerHour: number;
    maxConcurrentInvestigations: number;
  };
  escalationPolicy: {
    remindAfterMinutes: number;
    escalateAfterMinutes: number;
  };
  memoryWindowDays: number;
  shadowModeDefault?: boolean;
}

export interface SubagentProfile {
  scope: SubagentScope;
  autonomy: SubagentAutonomyPolicy;
}

export interface SubagentRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: SubagentStatus;
  scopeJson: SubagentScope;
  autonomyJson: SubagentAutonomyPolicy;
  packId?: string;
  channelBindingId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentMemoryRecord {
  id: string;
  subagentId: string;
  missionId?: string;
  deviceId?: string;
  kind: "mission-run" | "investigation" | "standing-order" | "delegation" | "operator-note";
  summary: string;
  detail: string;
  importance: "low" | "medium" | "high";
  evidenceJson: Record<string, unknown>;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StandingOrderRecord {
  id: string;
  subagentId: string;
  title: string;
  objective: string;
  instructions: string[];
  enabled: boolean;
  scopeJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type MissionStatus = "active" | "paused" | "completed" | "archived";
export type MissionPriority = "low" | "medium" | "high";
export type MissionRunStatus = "running" | "succeeded" | "blocked" | "failed";
export type MissionKind =
  | "availability-guardian"
  | "certificate-guardian"
  | "backup-guardian"
  | "storage-guardian"
  | "wan-guardian"
  | "daily-briefing"
  | "custom";

export interface MissionSelector {
  allDevices?: boolean;
  deviceIds?: string[];
  deviceTypes?: string[];
  deviceNames?: string[];
  servicesWithTls?: boolean;
  workloadCategory?: string;
  workloadNamePattern?: string;
  assuranceMonitorTypes?: string[];
}

export interface MissionTarget {
  selector?: MissionSelector;
  incidentTypes?: string[];
  findingTypes?: string[];
  recommendationPattern?: string;
  scheduleMode?: "cadence" | "systemDigest";
}

export interface MissionRecord {
  id: string;
  slug: string;
  title: string;
  summary: string;
  kind: MissionKind;
  status: MissionStatus;
  priority: MissionPriority;
  objective: string;
  subagentId?: string;
  packId?: string;
  cadenceMinutes: number;
  autoRun: boolean;
  autoApprove: boolean;
  shadowMode: boolean;
  targetJson: MissionTarget;
  stateJson: Record<string, unknown>;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: MissionRunStatus;
  lastSummary?: string;
  createdBy: "steward" | "user";
  createdAt: string;
  updatedAt: string;
}

export type MissionLinkResourceType =
  | "device"
  | "workload"
  | "assurance"
  | "incident"
  | "recommendation"
  | "investigation";

export interface MissionLinkRecord {
  id: string;
  missionId: string;
  resourceType: MissionLinkResourceType;
  resourceId: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MissionRunRecord {
  id: string;
  missionId: string;
  subagentId?: string;
  status: MissionRunStatus;
  summary: string;
  outcomeJson: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
}

export type MissionDelegationStatus = "open" | "accepted" | "completed" | "dismissed";

export interface MissionDelegationRecord {
  id: string;
  missionId: string;
  fromSubagentId?: string;
  toSubagentId: string;
  title: string;
  status: MissionDelegationStatus;
  reason: string;
  payloadJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MissionPlanRecord {
  id: string;
  missionId: string;
  summary: string;
  status: "active" | "blocked" | "completed";
  checkpointsJson: string[];
  delegationIdsJson: string[];
  createdAt: string;
  updatedAt: string;
}

export type InvestigationStatus = "open" | "monitoring" | "resolved" | "closed";
export type InvestigationSeverity = "critical" | "warning" | "info";
export type InvestigationStage =
  | "detect"
  | "correlate"
  | "hypothesize"
  | "probe"
  | "decide"
  | "act"
  | "verify"
  | "explain";
export type InvestigationStepKind =
  | "detect"
  | "observe"
  | "correlate"
  | "hypothesize"
  | "probe"
  | "decide"
  | "act"
  | "verify"
  | "explain"
  | "report";

export interface InvestigationRecord {
  id: string;
  missionId?: string;
  subagentId?: string;
  parentInvestigationId?: string;
  title: string;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  stage: InvestigationStage;
  objective: string;
  hypothesis?: string;
  summary: string;
  sourceType?: string;
  sourceId?: string;
  deviceId?: string;
  evidenceJson: Record<string, unknown>;
  recommendedActionsJson: string[];
  unresolvedQuestionsJson: string[];
  nextRunAt?: string;
  lastRunAt?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationStepRecord {
  id: string;
  investigationId: string;
  kind: InvestigationStepKind;
  status: "completed" | "pending";
  title: string;
  detail: string;
  evidenceJson: Record<string, unknown>;
  createdAt: string;
}

export type GatewayBindingKind = "telegram";

export interface GatewayBindingRecord {
  id: string;
  kind: GatewayBindingKind;
  name: string;
  enabled: boolean;
  target: string;
  vaultSecretRef?: string;
  webhookSecret?: string;
  defaultThreadTitle?: string;
  configJson: Record<string, unknown>;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayThreadRecord {
  id: string;
  bindingId: string;
  externalThreadKey: string;
  title: string;
  missionId?: string;
  subagentId?: string;
  chatSessionId?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayInboundEventRecord {
  id: string;
  bindingId: string;
  externalUpdateId: string;
  threadId?: string;
  receivedAt: string;
}

export interface BriefingRecord {
  id: string;
  scope: "global" | "subagent" | "mission";
  subagentId?: string;
  missionId?: string;
  bindingId?: string;
  title: string;
  body: string;
  format: "markdown" | "plain";
  delivered: boolean;
  deliveredAt?: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

export interface ChannelDeliveryRecord {
  id: string;
  bindingId: string;
  threadId?: string;
  missionId?: string;
  briefingId?: string;
  status: "queued" | "delivered" | "failed";
  textPreview: string;
  requestedAt: string;
  deliveredAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentWithMetrics extends SubagentRecord {
  missionCount: number;
  activeMissionCount: number;
  openInvestigationCount: number;
  memoryCount: number;
  standingOrderCount: number;
  delegationCount: number;
}

export interface MissionWithDetails extends MissionRecord {
  subagent?: SubagentRecord;
  links: MissionLinkRecord[];
  latestRun?: MissionRunRecord;
  openInvestigations: InvestigationRecord[];
  plan?: MissionPlanRecord;
  delegations: MissionDelegationRecord[];
}

export interface PackSummary extends PackRecord {
  subagentCount: number;
  missionTemplateCount: number;
  resourceCount: number;
}

export interface AutonomyLatencySummary {
  sampleCount: number;
  averageMs: number;
  p95Ms: number;
}

export interface AutonomyWorkerHealth {
  status: "healthy" | "degraded" | "offline";
  controlPlaneLeaderActive: boolean;
  pendingJobs: number;
  processingJobs: number;
  staleProcessingJobs: number;
  queueLagMs: number;
}

export interface AutonomyMetricsSnapshot {
  generatedAt: string;
  workerHealth: AutonomyWorkerHealth;
  missionLatency: AutonomyLatencySummary;
  briefingLatency: AutonomyLatencySummary;
  channelDeliveryLatency: AutonomyLatencySummary;
}
