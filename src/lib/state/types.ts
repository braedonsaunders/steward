export type AutonomyTier = 1 | 2 | 3;

export type DeviceType =
  | "server"
  | "workstation"
  | "router"
  | "firewall"
  | "switch"
  | "access-point"
  | "camera"
  | "nas"
  | "printer"
  | "iot"
  | "container-host"
  | "hypervisor"
  | "unknown";

export type DeviceStatus = "online" | "offline" | "degraded" | "unknown";

export type IncidentSeverity = "critical" | "warning" | "info";

export type RecommendationPriority = "high" | "medium" | "low";

export type ActionClass = "A" | "B" | "C" | "D";

export type EnvironmentLabel = "prod" | "staging" | "dev" | "lab";

export type PolicyDecision = "ALLOW_AUTO" | "REQUIRE_APPROVAL" | "DENY";

export type PlaybookFamily =
  | "service-recovery"
  | "cert-renewal"
  | "backup-retry"
  | "disk-cleanup"
  | "config-backup"
  | (string & {});

export type PlaybookStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "rolled_back";

export type PlaybookRunStatus =
  | "pending_approval"
  | "approved"
  | "denied"
  | "preflight"
  | "executing"
  | "verifying"
  | "rolling_back"
  | "completed"
  | "failed"
  | "quarantined";

export type GraphNodeType =
  | "device"
  | "service"
  | "incident"
  | "credential"
  | "baseline"
  | "site"
  | "user"
  | "policy"
  | "playbook_run";

export interface TlsCertInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  sans: string[];
  selfSigned: boolean;
}

export interface HttpInfo {
  serverHeader?: string;
  poweredBy?: string;
  title?: string;
  generator?: string;
  redirectsTo?: string;
}

export interface ServiceFingerprint {
  id: string;
  port: number;
  transport: "tcp" | "udp";
  name: string;
  product?: string;
  version?: string;
  secure: boolean;
  banner?: string;
  tlsCert?: TlsCertInfo;
  httpInfo?: HttpInfo;
  lastSeenAt: string;
}

export interface Device {
  id: string;
  name: string;
  ip: string;
  secondaryIps?: string[];
  mac?: string;
  hostname?: string;
  vendor?: string;
  os?: string;
  role?: string;
  type: DeviceType;
  status: DeviceStatus;
  autonomyTier: AutonomyTier;
  environmentLabel?: EnvironmentLabel;
  tags: string[];
  protocols: string[];
  services: ServiceFingerprint[];
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  metadata: Record<string, unknown>;
}

export interface DeviceBaseline {
  deviceId: string;
  avgLatencyMs: number;
  maxLatencyMs: number;
  minLatencyMs: number;
  samples: number;
  lastUpdatedAt: string;
}

export interface Incident {
  id: string;
  title: string;
  summary: string;
  severity: IncidentSeverity;
  deviceIds: string[];
  status: "open" | "in_progress" | "resolved";
  detectedAt: string;
  updatedAt: string;
  timeline: Array<{
    at: string;
    message: string;
  }>;
  diagnosis?: string;
  remediationPlan?: string;
  autoRemediated: boolean;
  metadata: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  impact: string;
  priority: RecommendationPriority;
  relatedDeviceIds: string[];
  createdAt: string;
  dismissed: boolean;
}

export interface ActionLog {
  id: string;
  at: string;
  actor: "steward" | "user";
  kind: "discover" | "diagnose" | "remediate" | "learn" | "config" | "auth" | "policy" | "playbook" | "approval" | "digest";
  message: string;
  context: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LLMProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "groq"
  | "xai"
  | "cohere"
  | "perplexity"
  | "fireworks"
  | "togetherai"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "custom";

export interface ProviderConfig {
  provider: LLMProvider;
  enabled: boolean;
  model: string;
  /** @deprecated Kept for DB column compatibility; no longer used at runtime. */
  apiKeyEnvVar?: string;
  oauthTokenSecret?: string;
  /** @deprecated Kept for DB column compatibility; no longer used at runtime. */
  oauthClientIdEnvVar?: string;
  /** @deprecated Kept for DB column compatibility; no longer used at runtime. */
  oauthClientSecretEnvVar?: string;
  oauthAuthUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string[];
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
}

export interface OAuthState {
  id: string;
  provider: LLMProvider;
  redirectUri: string;
  codeVerifier: string;
  createdAt: string;
  expiresAt: string;
}

export interface AgentRunRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  outcome: "ok" | "error";
  summary: string;
  details: Record<string, unknown>;
}

export interface RuntimeSettings {
  agentIntervalMs: number;
  deepScanIntervalMs: number;
  incrementalActiveTargets: number;
  deepActiveTargets: number;
  incrementalPortScanHosts: number;
  deepPortScanHosts: number;
  llmDiscoveryLimit: number;
  incrementalFingerprintTargets: number;
  deepFingerprintTargets: number;
  enableMdnsDiscovery: boolean;
  enableSsdpDiscovery: boolean;
  enableSnmpProbe: boolean;
  ouiUpdateIntervalMs: number;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  actionClasses?: ActionClass[];
  autonomyTiers?: AutonomyTier[];
  environmentLabels?: EnvironmentLabel[];
  deviceTypes?: DeviceType[];
  decision: PolicyDecision;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceWindow {
  id: string;
  name: string;
  deviceIds: string[];
  cronStart: string;
  durationMinutes: number;
  enabled: boolean;
  createdAt: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  ruleId: string | null;
  reason: string;
  evaluatedAt: string;
  inputs: {
    actionClass: ActionClass;
    autonomyTier: AutonomyTier;
    environmentLabel: EnvironmentLabel;
    inMaintenanceWindow: boolean;
    deviceId: string;
  };
}

export interface PlaybookStep {
  id: string;
  label: string;
  command: string;
  protocol: string;
  timeoutMs: number;
  status: PlaybookStepStatus;
  output?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PlaybookDefinition {
  id: string;
  family: PlaybookFamily;
  name: string;
  description: string;
  actionClass: ActionClass;
  blastRadius: "single-service" | "single-device" | "multi-device";
  timeoutMs: number;
  preconditions: {
    requiredProtocols: string[];
    requiredAutonomyTier?: AutonomyTier;
    healthChecks?: string[];
  };
  steps: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt">[];
  verificationSteps: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt">[];
  rollbackSteps: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt">[];
  /** Optional custom incident matcher for plugin playbooks. */
  matchesIncident?: (title: string, metadata: Record<string, unknown>) => boolean;
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  family: PlaybookFamily;
  name: string;
  deviceId: string;
  incidentId?: string;
  actionClass: ActionClass;
  status: PlaybookRunStatus;
  policyEvaluation: PolicyEvaluation;
  steps: PlaybookStep[];
  verificationSteps: PlaybookStep[];
  rollbackSteps: PlaybookStep[];
  evidence: {
    preSnapshot?: Record<string, unknown>;
    postSnapshot?: Record<string, unknown>;
    logs: string[];
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  deniedBy?: string;
  deniedAt?: string;
  denialReason?: string;
  expiresAt?: string;
  failureCount: number;
}

export interface DailyDigest {
  id: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  overnightIncidents: Array<{
    id: string;
    title: string;
    severity: IncidentSeverity;
    status: string;
    autoRemediated: boolean;
  }>;
  newRisks: Array<{
    type: "cert-expiry" | "backup-failure" | "firmware-vuln" | "other";
    description: string;
    deviceIds: string[];
  }>;
  pendingApprovals: Array<{
    id: string;
    summary: string;
    expiresAt: string;
  }>;
  topRecommendations: Array<{
    id: string;
    title: string;
    priority: RecommendationPriority;
    impact: string;
  }>;
  stats: {
    devicesOnline: number;
    devicesOffline: number;
    incidentsOpened: number;
    incidentsResolved: number;
    playbooksRun: number;
    playbooksSucceeded: number;
  };
}

export interface ChatSession {
  id: string;
  title: string;
  deviceId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  error: boolean;
  createdAt: string;
}

export interface StewardState {
  version: number;
  initializedAt: string;
  devices: Device[];
  baselines: DeviceBaseline[];
  incidents: Incident[];
  recommendations: Recommendation[];
  actions: ActionLog[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
  };
  providerConfigs: ProviderConfig[];
  oauthStates: OAuthState[];
  agentRuns: AgentRunRecord[];
  runtimeSettings: RuntimeSettings;
  policyRules: PolicyRule[];
  maintenanceWindows: MaintenanceWindow[];
  playbookRuns: PlaybookRun[];
  dailyDigests: DailyDigest[];
}
