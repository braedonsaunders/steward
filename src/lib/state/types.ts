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
  | "mqtt.message"
  | "cert.renew"
  | "file.copy"
  | "network.config";

export type RevertMechanism = "commit-confirmed" | "timed-rollback" | "manual";

export type HttpRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type MessageSuccessStrategy = "auto" | "transport" | "response" | "expectation";
export type WebSocketSuccessStrategy = MessageSuccessStrategy;
export type MqttMessageQos = 0 | 1 | 2;
export type LocalToolApprovalPolicy = "require_approval" | "allow_safe" | "allow_all" | "deny";
export type LocalToolRisk = "low" | "medium" | "high";
export type LocalToolSourceKind = "npm-package" | "binary-path";
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
  command?: string;
  argv?: string[];
  port?: number;
}

export interface TelnetBrokerRequest {
  protocol: "telnet";
  command: string;
  host?: string;
  port?: number;
  expectRegex?: string;
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
  sessionId?: string;
  sessionHolder?: string;
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
  sessionId?: string;
  sessionHolder?: string;
}

export interface MqttPublishMessage {
  topic: string;
  payload?: string;
  qos?: MqttMessageQos;
  retain?: boolean;
}

export interface MqttBrokerRequest {
  protocol: "mqtt";
  scheme?: "mqtt" | "mqtts";
  port?: number;
  clientId?: string;
  username?: string;
  clean?: boolean;
  qos?: MqttMessageQos;
  retain?: boolean;
  subscribeTopics?: string[];
  publishMessages?: MqttPublishMessage[];
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  collectMessages?: number;
  keepaliveSec?: number;
  expectRegex?: string;
  successStrategy?: MessageSuccessStrategy;
  insecureSkipVerify?: boolean;
  sessionId?: string;
  sessionHolder?: string;
  leaseTtlMs?: number;
  keepSessionOpen?: boolean;
  arbitrationMode?: ProtocolSessionArbitrationMode;
  singleConnectionHint?: boolean;
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

export interface PowerShellSshBrokerRequest {
  protocol: "powershell-ssh";
  command: string;
  host?: string;
  port?: number;
  expectRegex?: string;
}

export interface WmiBrokerRequest {
  protocol: "wmi";
  command: string;
  host?: string;
  namespace?: string;
  expectRegex?: string;
}

export interface SmbBrokerRequest {
  protocol: "smb";
  command: string;
  host?: string;
  share?: string;
  port?: number;
  expectRegex?: string;
}

export interface RdpBrokerRequest {
  protocol: "rdp";
  host?: string;
  port?: number;
  action?: "check" | "launch";
  admin?: boolean;
}

export interface LocalToolBrokerRequest {
  protocol: "local-tool";
  toolId: string;
  command: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  installIfMissing?: boolean;
  healthCheckBeforeRun?: boolean;
  approvalReason?: string;
}

export type ProtocolBrokerRequest =
  | SshBrokerRequest
  | TelnetBrokerRequest
  | HttpBrokerRequest
  | WebSocketBrokerRequest
  | MqttBrokerRequest
  | LocalToolBrokerRequest
  | WinrmBrokerRequest
  | PowerShellSshBrokerRequest
  | WmiBrokerRequest
  | SmbBrokerRequest
  | RdpBrokerRequest;

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
  | "waiting"
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
  | "waiting"
  | "verifying"
  | "rolling_back"
  | "completed"
  | "failed"
  | "quarantined";

export type PlaybookWaitPhase = "execution" | "verification" | "rollback";

export interface PlaybookWaitState {
  phase: PlaybookWaitPhase;
  stepId: string;
  label: string;
  nextWakeAt: string;
  reason: string;
}

export type GraphNodeType =
  | "device"
  | "service"
  | "workload"
  | "assurance"
  | "access_method"
  | "access_surface"
  | "device_profile"
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
  statusCode?: number;
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

export type NotificationChannelKind = "telegram" | "webhook";

export type NotificationEventKind =
  | "incident.opened"
  | "approval.requested"
  | "approval.escalated"
  | "approval.expired";

export type NotificationDeliveryStatus = "pending" | "delivered" | "failed";

export interface NotificationChannel {
  id: string;
  name: string;
  kind: NotificationChannelKind;
  enabled: boolean;
  target: string;
  eventKinds: NotificationEventKind[];
  minimumSeverity?: IncidentSeverity;
  vaultSecretRef?: string;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDelivery {
  id: string;
  channelId: string;
  eventKind: NotificationEventKind;
  eventRef: string;
  summary: string;
  payloadJson: Record<string, unknown>;
  status: NotificationDeliveryStatus;
  attempts: number;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalToolBinarySpec {
  name: string;
  bin: string;
  versionArgs?: string[];
  healthCheckArgs?: string[];
}

export interface LocalToolManifest {
  id: string;
  name: string;
  description: string;
  sourceKind: LocalToolSourceKind;
  risk: LocalToolRisk;
  packageName?: string;
  packageVersion?: string;
  binaryPath?: string;
  docsUrl?: string;
  capabilities: string[];
  bins: LocalToolBinarySpec[];
  runtimeHints?: {
    interactive?: boolean;
    requiresNetwork?: boolean;
    singleConnectionRisk?: boolean;
    vendor?: string;
  };
}

export type LocalToolStatus =
  | "not_installed"
  | "installing"
  | "installed"
  | "error"
  | "blocked"
  | "disabled";

export type LocalToolHealthStatus = "unknown" | "healthy" | "degraded" | "unavailable";

export interface LocalToolRecord {
  id: string;
  manifest: LocalToolManifest;
  enabled: boolean;
  status: LocalToolStatus;
  healthStatus: LocalToolHealthStatus;
  installDir?: string;
  binPaths: Record<string, string>;
  installedVersion?: string;
  lastInstalledAt?: string;
  lastCheckedAt?: string;
  lastRunAt?: string;
  approvedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type LocalToolApprovalAction = "install" | "upgrade" | "execute";
export type LocalToolApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface LocalToolApproval {
  id: string;
  toolId: string;
  action: LocalToolApprovalAction;
  status: LocalToolApprovalStatus;
  requestedBy: "steward" | "user";
  requestedAt: string;
  expiresAt?: string;
  reason: string;
  requestJson: Record<string, unknown>;
  approvedBy?: string;
  approvedAt?: string;
  deniedBy?: string;
  deniedAt?: string;
  denialReason?: string;
  decisionJson: Record<string, unknown>;
}

export interface LocalToolExecutionRequest {
  toolId: string;
  command: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  installIfMissing?: boolean;
  healthCheckBeforeRun?: boolean;
  approvalReason?: string;
}

export interface LocalToolExecutionResult {
  ok: boolean;
  toolId: string;
  command: string;
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  summary: string;
  binPath?: string;
  durationMs: number;
}

export type ProtocolSessionProtocol = "mqtt" | "websocket" | "web-session" | "rdp" | "vnc";
export type ProtocolSessionDesiredState = "active" | "idle" | "stopped";
export type ProtocolSessionStatus = "idle" | "connecting" | "connected" | "blocked" | "error" | "stopped";
export type ProtocolSessionArbitrationMode = "shared" | "exclusive" | "single-connection";
export type ProtocolSessionLeaseMode = "observe" | "exchange" | "command";
export type ProtocolSessionLeaseStatus = "pending" | "active" | "released" | "expired" | "rejected";
export type ProtocolSessionMessageDirection = "inbound" | "outbound" | "system";

export interface ProtocolSessionRecord {
  id: string;
  deviceId: string;
  protocol: ProtocolSessionProtocol;
  adapterId?: string;
  desiredState: ProtocolSessionDesiredState;
  status: ProtocolSessionStatus;
  arbitrationMode: ProtocolSessionArbitrationMode;
  singleConnectionHint: boolean;
  keepaliveAllowed: boolean;
  summary?: string;
  configJson: Record<string, unknown>;
  activeLeaseId?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProtocolSessionLease {
  id: string;
  sessionId: string;
  holder: string;
  purpose: string;
  mode: ProtocolSessionLeaseMode;
  status: ProtocolSessionLeaseStatus;
  exclusive: boolean;
  requestedAt: string;
  grantedAt?: string;
  releasedAt?: string;
  expiresAt: string;
  metadataJson: Record<string, unknown>;
}

export interface ProtocolSessionMessage {
  id: string;
  sessionId: string;
  deviceId: string;
  direction: ProtocolSessionMessageDirection;
  channel: string;
  payload: string;
  metadataJson: Record<string, unknown>;
  observedAt: string;
}

export interface Device {
  id: string;
  siteId?: string;
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
  | "draft"
  | "access"
  | "profiles"
  | "credentials"
  | "contract"
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

export type AccessMethodKind =
  | "ssh"
  | "telnet"
  | "winrm"
  | "powershell-ssh"
  | "wmi"
  | "smb"
  | "snmp"
  | "http-api"
  | "docker"
  | "kubernetes"
  | "mqtt"
  | "printing"
  | "rdp"
  | (string & {});

export type AccessMethodStatus =
  | "observed"
  | "credentialed"
  | "validated"
  | "rejected";

export interface AccessMethod {
  id: string;
  deviceId: string;
  key: string;
  kind: AccessMethodKind;
  title: string;
  protocol: string;
  port?: number;
  secure: boolean;
  selected: boolean;
  status: AccessMethodStatus;
  credentialProtocol?: string;
  summary?: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type DeviceProfileStatus =
  | "candidate"
  | "selected"
  | "verified"
  | "active"
  | "rejected";

export type DeviceProfileKind = "primary" | "fallback" | "supporting";

export interface DeviceProfileBinding {
  id: string;
  deviceId: string;
  profileId: string;
  adapterId?: string;
  name: string;
  kind: DeviceProfileKind;
  confidence: number;
  status: DeviceProfileStatus;
  summary: string;
  requiredAccessMethods: string[];
  requiredCredentialProtocols: string[];
  evidenceJson: Record<string, unknown>;
  draftJson: Record<string, unknown>;
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

export interface OnboardingCredentialRequest {
  protocol: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface OnboardingDraftWorkload {
  workloadKey: string;
  displayName: string;
  category?: WorkloadCategory;
  criticality: "low" | "medium" | "high";
  summary?: string;
  evidenceJson?: Record<string, unknown>;
}

export interface OnboardingDraftAssurance {
  assuranceKey: string;
  workloadKey?: string;
  displayName: string;
  criticality: "low" | "medium" | "high";
  desiredState?: "running" | "stopped";
  checkIntervalSec: number;
  monitorType?: string;
  requiredProtocols?: string[];
  rationale?: string;
  configJson?: Record<string, unknown>;
}

export interface OnboardingDraft {
  version: number;
  summary: string;
  selectedProfileIds: string[];
  selectedAccessMethodKeys: string[];
  credentialRequests: OnboardingCredentialRequest[];
  workloads: OnboardingDraftWorkload[];
  assurances: OnboardingDraftAssurance[];
  nextActions: string[];
  unresolvedQuestions: string[];
  residualUnknowns: string[];
  dismissedWorkloadKeys: string[];
  dismissedAssuranceKeys: string[];
  completionReady: boolean;
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

export interface FindingOccurrence {
  id: string;
  findingId?: string;
  deviceId: string;
  dedupeKey: string;
  findingType: string;
  severity: IncidentSeverity;
  status: "open" | "resolved";
  summary: string;
  evidenceJson: Record<string, unknown>;
  source: string;
  observedAt: string;
  metadataJson: Record<string, unknown>;
}

export type DeviceWidgetStatus = "active" | "disabled";

export type DeviceWidgetCapability = "context" | "state" | "device-control";

export type DeviceWidgetControlKind = "button" | "toggle" | "select" | "form";
export type DeviceWidgetControlParameterType = "string" | "number" | "boolean" | "enum";
export type DeviceWidgetControlStateMergeStrategy = "deep-merge" | "replace";

export interface DeviceWidgetControlOption {
  label: string;
  value: string;
  description?: string;
}

export interface DeviceWidgetControlParameter {
  key: string;
  label: string;
  description?: string;
  type: DeviceWidgetControlParameterType;
  required?: boolean;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  options?: DeviceWidgetControlOption[];
}

export interface DeviceWidgetControlOperation {
  mode: OperationMode;
  kind: OperationKind;
  adapterId?: string;
  timeoutMs?: number;
  commandTemplate?: string;
  brokerRequest?: ProtocolBrokerRequest;
  args?: Record<string, string | number | boolean>;
  expectedSemanticTarget?: string;
}

export interface DeviceWidgetControlOperationExecution {
  kind: "operation";
  operation: DeviceWidgetControlOperation;
}

export interface DeviceWidgetControlStateExecution {
  kind: "state";
  patch: Record<string, unknown>;
  mergeStrategy?: DeviceWidgetControlStateMergeStrategy;
}

export type DeviceWidgetControlExecution =
  | DeviceWidgetControlOperationExecution
  | DeviceWidgetControlStateExecution;

export interface DeviceWidgetControl {
  id: string;
  label: string;
  description?: string;
  kind: DeviceWidgetControlKind;
  parameters: DeviceWidgetControlParameter[];
  execution: DeviceWidgetControlExecution;
  confirmation?: string;
  successMessage?: string;
  danger?: boolean;
}

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
  controls: DeviceWidgetControl[];
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

export interface DashboardWidgetInventoryEntry {
  widgetId: string;
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  deviceStatus: DeviceStatus;
  widgetSlug: string;
  widgetName: string;
  widgetDescription?: string;
  widgetStatus: DeviceWidgetStatus;
  widgetRevision: number;
  capabilities: DeviceWidgetCapability[];
  updatedAt: string;
}

export interface DashboardWidgetPageRecord {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWidgetPageItemRecord {
  id: string;
  pageId: string;
  widgetId: string;
  title?: string;
  columnStart: number;
  columnSpan: number;
  rowStart: number;
  rowSpan: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWidgetPageItem extends DashboardWidgetPageItemRecord {
  widget: DashboardWidgetInventoryEntry;
}

export interface DashboardWidgetPage extends DashboardWidgetPageRecord {
  items: DashboardWidgetPageItem[];
}

export type WidgetOperationStatus = OperationExecutionStatus | "requires-approval";
export type DeviceWidgetControlExecutionStatus = WidgetOperationStatus | "succeeded";

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

export interface DeviceWidgetControlResult {
  ok: boolean;
  status: DeviceWidgetControlExecutionStatus;
  summary: string;
  widgetId: string;
  widgetName: string;
  controlId: string;
  controlLabel: string;
  executionKind: DeviceWidgetControlExecution["kind"];
  approvalRequired: boolean;
  approved: boolean;
  details: Record<string, unknown>;
  stateJson?: Record<string, unknown>;
  operationResult?: WidgetOperationResult;
  startedAt: string;
  completedAt: string;
}

export type DeviceAutomationTargetKind =
  | "widget-control"
  | "device-operation"
  | "playbook"
  | "local-tool";
export type DeviceAutomationScheduleKind = "manual" | "interval" | "daily";
export type DeviceAutomationRunStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "requires-approval";

export interface DeviceAutomation {
  id: string;
  deviceId: string;
  targetKind: DeviceAutomationTargetKind;
  widgetId: string;
  controlId: string;
  targetJson: Record<string, unknown>;
  name: string;
  description?: string;
  enabled: boolean;
  scheduleKind: DeviceAutomationScheduleKind;
  intervalMinutes?: number;
  hourLocal?: number;
  minuteLocal?: number;
  inputJson: Record<string, unknown>;
  lastRunAt?: string;
  nextRunAt?: string;
  lastRunStatus?: DeviceAutomationRunStatus;
  lastRunSummary?: string;
  createdBy: "steward" | "user";
  createdAt: string;
  updatedAt: string;
}

export interface DeviceAutomationRun {
  id: string;
  automationId: string;
  deviceId: string;
  widgetId: string;
  controlId: string;
  status: DeviceAutomationRunStatus;
  summary: string;
  resultJson: Record<string, unknown>;
  createdAt: string;
  completedAt?: string;
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
  updatedAt: string;
  dismissed: boolean;
}

export interface ActionLog {
  id: string;
  at: string;
  actor: "steward" | "user";
  kind:
    | "discover"
    | "diagnose"
    | "remediate"
    | "learn"
    | "config"
    | "auth"
    | "policy"
    | "playbook"
    | "approval"
    | "digest"
    | "notification"
    | "mission"
    | "investigation"
    | "gateway"
    | "pack";
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

export interface GraphNodeVersion {
  id: string;
  nodeId: string;
  label: string;
  properties: Record<string, unknown>;
  snapshotHash: string;
  versionedAt: string;
}

export interface GraphEdgeVersion {
  id: string;
  edgeId: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
  snapshotHash: string;
  versionedAt: string;
}

export interface SiteRecord {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export type MetricScopeType = "device" | "assurance" | "workload" | "service" | "site" | "steward";

export interface MetricSeries {
  id: string;
  scopeType: MetricScopeType;
  scopeId: string;
  metricKey: string;
  unit?: string;
  source: string;
  retentionDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface MetricSample {
  id: string;
  seriesId: string;
  scopeType: MetricScopeType;
  scopeId: string;
  metricKey: string;
  value: number;
  unit?: string;
  source: string;
  observedAt: string;
  dimensionsJson: Record<string, unknown>;
  anomalyScore?: number;
  baselineLower?: number;
  baselineUpper?: number;
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
  oauthTokenSecret?: string;
  oauthAuthUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string[];
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  updatedAt?: string;
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

export interface ScannerRunRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  outcome: "ok" | "error";
  summary: string;
  details: Record<string, unknown>;
}

export interface ControlPlaneLeaseRecord {
  name: string;
  holder: string;
  expiresAt: string;
  updatedAt: string;
  metadataJson: Record<string, unknown>;
}

export interface ControlPlaneQueueLane {
  kind: string;
  pending: number;
  processing: number;
  completed: number;
  oldestPendingRunAfter?: string;
  oldestProcessingUpdatedAt?: string;
  newestUpdatedAt?: string;
}

export interface ControlPlaneHealth {
  leases: ControlPlaneLeaseRecord[];
  queue: ControlPlaneQueueLane[];
  summary: {
    pending: number;
    processing: number;
    longRunningProcessing: number;
  };
  lastSuccessfulScannerRun: ScannerRunRecord | null;
  lastSuccessfulAgentWake: AgentRunRecord | null;
  lastPeriodicAgentWake: AgentRunRecord | null;
}

export type WebResearchProvider = "brave_scrape" | "duckduckgo_scrape" | "brave_api" | "serper" | "serpapi";
export type WebResearchFallbackStrategy = "prefer_non_key" | "key_only" | "selected_only";

export interface RuntimeSettings {
  scannerIntervalMs: number;
  agentWakeIntervalMs: number;
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
  webResearchProvider: WebResearchProvider;
  webResearchFallbackStrategy: WebResearchFallbackStrategy;
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
  localToolInstallPolicy: LocalToolApprovalPolicy;
  localToolExecutionPolicy: LocalToolApprovalPolicy;
  localToolApprovalTtlMs: number;
  localToolHealthCheckIntervalMs: number;
  localToolAutoInstallBuiltins: boolean;
  protocolSessionSweepIntervalMs: number;
  protocolSessionDefaultLeaseTtlMs: number;
  protocolSessionMaxLeaseTtlMs: number;
  protocolSessionMessageRetentionLimit: number;
  protocolSessionReconnectBaseMs: number;
  protocolSessionReconnectMaxMs: number;
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
  nextAttemptAt?: string;
  attempts?: number;
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
    waiting?: PlaybookWaitState;
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
  updatedAt?: string;
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
  missionId?: string;
  subagentId?: string;
  gatewayThreadId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatToolEventStatus = "running" | "completed" | "failed";

export type ChatToolEventKind = "tool" | "probe" | "terminal" | "desktop";

export type ChatToolWidgetMutationAction = "created" | "updated" | "deleted";

export interface ChatToolWidgetMutation {
  action: ChatToolWidgetMutationAction;
  deviceId: string;
  widgetId: string;
  widgetSlug?: string;
}

export type ChatToolOnboardingMutationAction = "show_contract_review";

export interface ChatToolOnboardingMutation {
  action: ChatToolOnboardingMutationAction;
  deviceId: string;
}

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
  widgetMutation?: ChatToolWidgetMutation;
  onboardingMutation?: ChatToolOnboardingMutation;
}

export interface ChatMessagePlaybookRunLink {
  runId: string;
  deviceId: string;
  status: PlaybookRunStatus;
}

export interface ChatMessageMetadata {
  toolEvents?: ChatToolEvent[];
  interrupted?: boolean;
  playbookRun?: ChatMessagePlaybookRunLink;
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
  sites: SiteRecord[];
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
  scannerRuns: ScannerRunRecord[];
  agentRuns: AgentRunRecord[];
  runtimeSettings: RuntimeSettings;
  policyRules: PolicyRule[];
  maintenanceWindows: MaintenanceWindow[];
  playbookRuns: PlaybookRun[];
  dailyDigests: DailyDigest[];
  localTools: LocalToolRecord[];
  localToolApprovals: LocalToolApproval[];
  protocolSessions: ProtocolSessionRecord[];
  protocolSessionLeases: ProtocolSessionLease[];
  dashboardWidgetPages: DashboardWidgetPage[];
  systemSettings: SystemSettings;
  authSettings: AuthSettings;
}

export type StateStreamSection =
  | "actions"
  | "agentRuns"
  | "baselines"
  | "devices"
  | "graph"
  | "incidents"
  | "playbookRuns"
  | "recommendations"
  | "scannerRuns";

export type StateStreamSectionData = Pick<
  StewardState,
  "actions" | "agentRuns" | "baselines" | "devices" | "incidents" | "playbookRuns" | "recommendations" | "scannerRuns"
> & {
  graph: StewardState["graph"];
};

export interface StateStreamPatch {
  revisions: Partial<Record<StateStreamSection, string>>;
  sections: Partial<StateStreamSectionData>;
  controlPlane?: ControlPlaneHealth | null;
}

