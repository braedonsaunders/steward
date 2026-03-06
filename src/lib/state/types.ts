export type AutonomyTier = 1 | 2 | 3;

export const DEVICE_TYPE_VALUES = [
  "server",
  "workstation",
  "laptop",
  "smartphone",
  "tablet",
  "router",
  "firewall",
  "switch",
  "access-point",
  "modem",
  "load-balancer",
  "vpn-appliance",
  "wan-optimizer",
  "camera",
  "nvr",
  "dvr",
  "nas",
  "san",
  "printer",
  "scanner",
  "pbx",
  "voip-phone",
  "conference-system",
  "point-of-sale",
  "badge-reader",
  "door-controller",
  "ups",
  "pdu",
  "bmc",
  "iot",
  "sensor",
  "controller",
  "smart-tv",
  "media-streamer",
  "game-console",
  "container-host",
  "hypervisor",
  "vm-host",
  "kubernetes-master",
  "kubernetes-worker",
  "unknown",
] as const;

export type DeviceType = (typeof DEVICE_TYPE_VALUES)[number];

export type DeviceStatus = "online" | "offline" | "degraded" | "unknown";

export type DiscoveryObservationSource =
  | "passive"
  | "active"
  | "mdns"
  | "ssdp"
  | "fingerprint"
  | "fusion";

export type DiscoveryEvidenceType =
  | "arp_resolved"
  | "icmp_reply"
  | "tcp_open"
  | "nmap_host_up"
  | "nmap_script"
  | "mdns_announcement"
  | "ssdp_response"
  | "dhcp_lease"
  | "packet_traffic_profile"
  | "browser_observation"
  | "favicon_hash"
  | "dns_ptr"
  | "dns_service"
  | "snmp_sysdescr"
  | "http_banner"
  | "tls_cert"
  | "ssh_banner"
  | "smb_negotiate"
  | "winrm_endpoint"
  | "mqtt_connack"
  | "netbios_name"
  | "protocol_hint";

export interface DiscoveryObservationInput {
  ip: string;
  source: DiscoveryObservationSource;
  evidenceType: DiscoveryEvidenceType;
  confidence: number;
  observedAt: string;
  expiresAt?: string;
  ttlMs?: number;
  details?: Record<string, unknown>;
}

export interface DiscoveryObservation {
  id: string;
  ip: string;
  deviceId?: string;
  source: DiscoveryObservationSource;
  evidenceType: DiscoveryEvidenceType;
  confidence: number;
  observedAt: string;
  expiresAt: string;
  details: Record<string, unknown>;
}

export type IncidentSeverity = "critical" | "warning" | "info";

export type RecommendationPriority = "high" | "medium" | "low";

export type ActionClass = "A" | "B" | "C" | "D";

export type EnvironmentLabel = "prod" | "staging" | "dev" | "lab";

export type PolicyDecision = "ALLOW_AUTO" | "REQUIRE_APPROVAL" | "DENY";

export type ExecutionLane = "A" | "B" | "C";

export type LlmHealthState = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE" | "SAFE_MODE";

export type OperationMode = "read" | "mutate";

export type OperationKind =
  | "shell.command"
  | "service.restart"
  | "service.stop"
  | "container.restart"
  | "container.stop"
  | "http.request"
  | "websocket.message"
  | "cert.renew"
  | "file.copy"
  | "network.config";

export type RevertMechanism = "commit-confirmed" | "timed-rollback" | "manual";

export type HttpRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type WebSocketSuccessStrategy = "auto" | "transport" | "response" | "expectation";
export type WinrmAuthentication =
  | "default"
  | "basic"
  | "negotiate"
  | "kerberos"
  | "credssp"
  | "digest"
  | (string & {});

export type OperationExecutionStatus = "succeeded" | "failed" | "blocked" | "inconclusive";

export type OperationExecutionPhase =
  | "not-started"
  | "blocked"
  | "connected"
  | "sent"
  | "responded"
  | "executed"
  | "verified";

export type OperationExecutionProof = "none" | "process" | "transport" | "response" | "expectation";

export interface SshBrokerRequest {
  protocol: "ssh";
  argv: string[];
  port?: number;
}

export interface HttpBrokerRequest {
  protocol: "http";
  method: HttpRequestMethod;
  scheme?: "http" | "https";
  schemes?: Array<"http" | "https">;
  port?: number;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: string;
  insecureSkipVerify?: boolean;
  expectRegex?: string;
}

export interface WebSocketBrokerRequest {
  protocol: "websocket";
  scheme?: "ws" | "wss";
  port?: number;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  protocols?: string[];
  messages?: string[];
  sendOn?: "open" | "first-message";
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  collectMessages?: number;
  expectRegex?: string;
  successStrategy?: WebSocketSuccessStrategy;
}

export interface WinrmBrokerRequest {
  protocol: "winrm";
  command: string;
  host?: string;
  port?: number;
  useSsl?: boolean;
  skipCertChecks?: boolean;
  authentication?: WinrmAuthentication;
  expectRegex?: string;
}

export type ProtocolBrokerRequest =
  | SshBrokerRequest
  | HttpBrokerRequest
  | WebSocketBrokerRequest
  | WinrmBrokerRequest;

export interface OperationSafetyProfile {
  dryRunSupported: boolean;
  dryRunCommandTemplate?: string;
  requiresConfirmedRevert: boolean;
  revertMechanism?: RevertMechanism;
  riskTags?: string[];
  criticality?: "low" | "medium" | "high";
}

export interface OperationSpec {
  id: string;
  adapterId: string;
  kind: OperationKind;
  mode: OperationMode;
  timeoutMs: number;
  commandTemplate?: string;
  brokerRequest?: ProtocolBrokerRequest;
  args?: Record<string, string | number | boolean>;
  expectedSemanticTarget?: string;
  safety: OperationSafetyProfile;
}

export type SafetyGateName = "schema" | "state_hash" | "policy" | "dry_run";

export interface SafetyGateResult {
  gate: SafetyGateName;
  passed: boolean;
  message: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface CapabilityTokenScope {
  deviceId: string;
  adapterId: string;
  operationKinds: OperationKind[];
  mode: OperationMode;
}

export interface CapabilityToken {
  token: string;
  scope: CapabilityTokenScope;
  issuedAt: string;
  expiresAt: string;
}

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
  | "workload"
  | "assurance"
  | "access_surface"
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

export interface ObservedEndpoint {
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

export type ServiceFingerprint = ObservedEndpoint;

export type WorkloadCategory =
  | "application"
  | "platform"
  | "data"
  | "network"
  | "perimeter"
  | "storage"
  | "telemetry"
  | "background"
  | "unknown";

export interface Workload {
  id: string;
  deviceId: string;
  workloadKey: string;
  displayName: string;
  category: WorkloadCategory;
  criticality: "low" | "medium" | "high";
  source: "legacy_contract" | "onboarding_profile" | "onboarding_conversation" | "chat_monitor" | "operator" | "migration";
  summary?: string;
  evidenceJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Assurance {
  id: string;
  deviceId: string;
  workloadId?: string;
  assuranceKey: string;
  displayName: string;
  criticality: "low" | "medium" | "high";
  desiredState: "running" | "stopped";
  checkIntervalSec: number;
  monitorType?: string;
  requiredProtocols?: string[];
  rationale?: string;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Legacy compatibility while the rest of the codebase finishes cutting over.
  serviceKey: string;
  policyJson: Record<string, unknown>;
}

export type ServiceContract = Assurance;

export interface AssuranceRun {
  id: string;
  assuranceId: string;
  deviceId: string;
  workloadId?: string;
  status: "pass" | "fail" | "pending";
  summary: string;
  evidenceJson: Record<string, unknown>;
  evaluatedAt: string;
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
  services: ObservedEndpoint[];
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  metadata: Record<string, unknown>;
}

export type AdoptionRunStatus = "running" | "awaiting_user" | "completed" | "failed";

export type AdoptionRunStage =
  | "profile"
  | "questions"
  | "credentials"
  | "adapter_binding"
  | "activation"
  | "completed"
  | "failed";

export interface AdoptionRun {
  id: string;
  deviceId: string;
  status: AdoptionRunStatus;
  stage: AdoptionRunStage;
  profileJson: Record<string, unknown>;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdoptionQuestionOption {
  label: string;
  value: string;
}

export interface AdoptionQuestion {
  id: string;
  runId: string;
  deviceId: string;
  questionKey: string;
  prompt: string;
  options: AdoptionQuestionOption[];
  required: boolean;
  answerJson?: Record<string, unknown>;
  answeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type DeviceCredentialStatus = "pending" | "provided" | "validated" | "invalid";

export interface DeviceCredential {
  id: string;
  deviceId: string;
  protocol: string;
  adapterId?: string;
  vaultSecretRef: string;
  accountLabel?: string;
  scopeJson: Record<string, unknown>;
  status: DeviceCredentialStatus;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialAccessLog {
  id: string;
  credentialId?: string;
  deviceId: string;
  protocol: string;
  playbookRunId?: string;
  operationId?: string;
  adapterId?: string;
  actor: "steward" | "user";
  purpose: string;
  result: "granted" | "missing_secret" | "no_stored_credential" | "credential_unusable";
  details: Record<string, unknown>;
  accessedAt: string;
}

export interface AccessSurface {
  id: string;
  deviceId: string;
  adapterId: string;
  protocol: string;
  score: number;
  selected: boolean;
  reason: string;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type DeviceAdapterBinding = AccessSurface;

export interface DeviceFinding {
  id: string;
  deviceId: string;
  dedupeKey: string;
  findingType: string;
  severity: IncidentSeverity;
  title: string;
  summary: string;
  evidenceJson: Record<string, unknown>;
  status: "open" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
}

export type DeviceWidgetStatus = "active" | "disabled";

export type DeviceWidgetCapability = "context" | "state" | "device-control";

export interface DeviceWidget {
  id: string;
  deviceId: string;
  slug: string;
  name: string;
  description?: string;
  status: DeviceWidgetStatus;
  html: string;
  css: string;
  js: string;
  capabilities: DeviceWidgetCapability[];
  sourcePrompt?: string;
  createdBy: "steward" | "user";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceWidgetRuntimeState {
  widgetId: string;
  deviceId: string;
  stateJson: Record<string, unknown>;
  updatedAt: string;
}

export type WidgetOperationStatus = OperationExecutionStatus | "requires-approval";

export interface WidgetOperationResult {
  ok: boolean;
  status: WidgetOperationStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  summary: string;
  output: string;
  details: Record<string, unknown>;
  gateResults: SafetyGateResult[];
  idempotencyKey: string;
  policyDecision: PolicyDecision;
  policyReason: string;
  approvalRequired: boolean;
  approved: boolean;
  startedAt: string;
  completedAt: string;
}

export interface DeviceWidgetOperationRun {
  id: string;
  widgetId: string;
  deviceId: string;
  widgetRevision: number;
  operationKind: OperationKind;
  operationMode: OperationMode;
  brokerProtocol?: ProtocolBrokerRequest["protocol"];
  status: WidgetOperationStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  approvalRequired: boolean;
  policyDecision: PolicyDecision;
  policyReason: string;
  approved: boolean;
  idempotencyKey: string;
  summary: string;
  output: string;
  operationJson: Record<string, unknown>;
  detailsJson: Record<string, unknown>;
  createdAt: string;
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
  enableAdvancedNmapFingerprint: boolean;
  nmapFingerprintTimeoutMs: number;
  incrementalNmapTargets: number;
  deepNmapTargets: number;
  enablePacketIntel: boolean;
  packetIntelDurationSec: number;
  packetIntelMaxPackets: number;
  packetIntelTopTalkers: number;
  enableBrowserObservation: boolean;
  browserObservationTimeoutMs: number;
  incrementalBrowserObservationTargets: number;
  deepBrowserObservationTargets: number;
  browserObservationCaptureScreenshots: boolean;
  enableWebResearch: boolean;
  webResearchTimeoutMs: number;
  webResearchMaxResults: number;
  webResearchDeepReadPages: number;
  enableDhcpLeaseIntel: boolean;
  dhcpLeaseCommandTimeoutMs: number;
  ouiUpdateIntervalMs: number;
  laneBEnabled: boolean;
  laneBAllowedEnvironments: EnvironmentLabel[];
  laneBAllowedFamilies: string[];
  laneCMutationsInLab: boolean;
  laneCMutationsInProd: boolean;
  mutationRequireDryRunWhenSupported: boolean;
  approvalTtlClassBMs: number;
  approvalTtlClassCMs: number;
  approvalTtlClassDMs: number;
  quarantineThresholdCount: number;
  quarantineThresholdWindowMs: number;
  availabilityScannerAlertsEnabled: boolean;
  securityScannerAlertsEnabled: boolean;
  serviceContractScannerAlertsEnabled: boolean;
  ignoredIncidentTypes: string[];
}

export type UserRole = "Owner" | "Admin" | "Operator" | "Auditor" | "ReadOnly";

export type AuthMode = "open" | "token" | "session" | "hybrid";

export type AuthProviderType = "local" | "oidc" | "ldap";

export interface OidcAuthSettings {
  enabled: boolean;
  issuer: string;
  clientId: string;
  scopes: string;
  autoProvision: boolean;
  defaultRole: UserRole;
  clientSecretConfigured: boolean;
}

export interface LdapAuthSettings {
  enabled: boolean;
  url: string;
  baseDn: string;
  bindDn: string;
  userFilter: string;
  uidAttribute: string;
  autoProvision: boolean;
  defaultRole: UserRole;
  bindPasswordConfigured: boolean;
}

export interface SystemSettings {
  nodeIdentity: string;
  timezone: string;
  digestScheduleEnabled: boolean;
  digestHourLocal: number;
  digestMinuteLocal: number;
  upgradeChannel: "stable" | "preview";
}

export interface AuthSettings {
  apiTokenEnabled: boolean;
  mode: AuthMode;
  sessionTtlHours: number;
  oidc: OidcAuthSettings;
  ldap: LdapAuthSettings;
}

export interface SettingsHistoryEntry<T = Record<string, unknown>> {
  id: string;
  domain: "runtime" | "system" | "auth";
  version: number;
  effectiveFrom: string;
  payload: T;
  actor: "steward" | "user";
  createdAt: string;
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
  riskScore: number;
  riskFactors: string[];
  evaluatedAt: string;
  inputs: {
    actionClass: ActionClass;
    autonomyTier: AutonomyTier;
    environmentLabel: EnvironmentLabel;
    inMaintenanceWindow: boolean;
    deviceId: string;
    blastRadius: "single-service" | "single-device" | "multi-device";
    criticality: "low" | "medium" | "high";
    lane: ExecutionLane;
    recentFailures: number;
    quarantineActive: boolean;
  };
}

export interface PlaybookStep {
  id: string;
  label: string;
  operation: OperationSpec;
  status: PlaybookStepStatus;
  output?: string;
  startedAt?: string;
  completedAt?: string;
  gateResults?: SafetyGateResult[];
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
  /** Optional custom incident matcher for adapter playbooks. */
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
    preSnapshot?: Record<string, unknown> & { stateHash?: string };
    postSnapshot?: Record<string, unknown> & { stateHash?: string };
    logs: string[];
    gateResults?: SafetyGateResult[];
    auditBundle?: {
      actor: "steward" | "user";
      lane: ExecutionLane;
      rationale: string;
      operations: Array<{
        stepId: string;
        operationId: string;
        adapterId: string;
        mode: OperationMode;
        input: Record<string, unknown>;
        output: string;
        ok: boolean;
        startedAt: string;
        completedAt: string;
        idempotencyKey: string;
      }>;
    };
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

export type ChatToolEventStatus = "running" | "completed" | "failed";

export type ChatToolEventKind = "tool" | "probe" | "terminal";

export interface ChatToolEvent {
  id: string;
  toolName: string;
  label: string;
  kind: ChatToolEventKind;
  status: ChatToolEventStatus;
  startedAt: string;
  finishedAt?: string;
  anchorOffset?: number;
  inputPreview?: string;
  summary?: string;
  outputPreview?: string;
  error?: string;
}

export interface ChatMessageMetadata {
  toolEvents?: ChatToolEvent[];
  interrupted?: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  error: boolean;
  createdAt: string;
  metadata?: ChatMessageMetadata;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  provider: AuthProviderType;
  externalId?: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip?: string;
  userAgent?: string;
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
  systemSettings: SystemSettings;
  authSettings: AuthSettings;
}
