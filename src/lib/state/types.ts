export type AutonomyTier = 1 | 2 | 3;

export type DeviceType =
  | "server"
  | "workstation"
  | "router"
  | "switch"
  | "access-point"
  | "nas"
  | "printer"
  | "iot"
  | "container-host"
  | "hypervisor"
  | "unknown";

export type DeviceStatus = "online" | "offline" | "degraded" | "unknown";

export type IncidentSeverity = "critical" | "warning" | "info";

export type RecommendationPriority = "high" | "medium" | "low";

export type GraphNodeType =
  | "device"
  | "service"
  | "incident"
  | "credential"
  | "baseline"
  | "site"
  | "user";

export interface ServiceFingerprint {
  id: string;
  port: number;
  transport: "tcp" | "udp";
  name: string;
  product?: string;
  version?: string;
  secure: boolean;
  lastSeenAt: string;
}

export interface Device {
  id: string;
  name: string;
  ip: string;
  mac?: string;
  hostname?: string;
  vendor?: string;
  os?: string;
  role?: string;
  type: DeviceType;
  status: DeviceStatus;
  autonomyTier: AutonomyTier;
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
  kind: "discover" | "diagnose" | "remediate" | "learn" | "config" | "auth";
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
  apiKeyEnvVar?: string;
  oauthTokenSecret?: string;
  oauthClientIdEnvVar?: string;
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
}
