import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { Device, OperationKind, OperationMode, PlaybookDefinition } from "@/lib/state/types";
import type { ManagementCapability } from "@/lib/protocols/negotiator";

// ---------------------------------------------------------------------------
// Adapter Manifest (manifest.json)
// ---------------------------------------------------------------------------

export type AdapterCapability =
  | "discovery"
  | "playbooks"
  | "enrichment"
  | "protocol"
  | "profile";

export type AdapterConfigFieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "json";

export interface AdapterConfigOption {
  label: string;
  value: string | number | boolean;
}

export interface AdapterConfigField {
  key: string;
  label: string;
  description?: string;
  type: AdapterConfigFieldType;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  options?: AdapterConfigOption[];
}

export interface AdapterLlmToolCall {
  name: string;
  description: string;
  /** JSON schema object for tool-call arguments */
  parameters: Record<string, unknown>;
}

export interface AdapterSkillMarkdown {
  path: string;
  content: string;
  truncated?: boolean;
}

export interface AdapterToolSkill {
  id: string;
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  operationKinds?: OperationKind[];
  enabledByDefault?: boolean;
  defaultConfig?: Record<string, unknown>;
  /** Formal LLM tool-call contract for this skill */
  toolCall?: AdapterLlmToolCall;
  /** Optional execution defaults for generic chat tool runtime */
  execution?: {
    kind?: OperationKind;
    mode?: OperationMode;
    adapterId?: string;
    timeoutMs?: number;
    expectedSemanticTarget?: string;
    commandTemplate?: string;
    commandTemplates?: Partial<Record<OperationKind, string>>;
    localToolId?: string;
    localToolCommand?: string;
    localToolArgs?: string[];
    localToolCwd?: string;
    localToolInstallIfMissing?: boolean;
  };
  /** Optional relative path to Markdown guidance (e.g. skills/my-tool.md) */
  skillMdPath?: string;
  /** Hydrated Markdown attachment (runtime/API only) */
  skillMd?: AdapterSkillMarkdown;
}

export interface AdapterManifest {
  /** Unique adapter ID, e.g. "com.example.unifi-discovery" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Semver version string */
  version: string;
  /** Adapter author */
  author: string;
  /** Relative path to the entry module (default: "index.js") */
  entry?: string;
  /** What this adapter provides */
  provides: AdapterCapability[];
  /** UI-configurable field definitions */
  configSchema?: AdapterConfigField[];
  /** Default runtime configuration */
  defaultConfig?: Record<string, unknown>;
  /** Tool skills exposed by this adapter */
  toolSkills?: AdapterToolSkill[];
  /** Optional default per-tool runtime config keyed by skill id */
  defaultToolConfig?: Record<string, Record<string, unknown>>;
  /** Optional adapter docs URL */
  docsUrl?: string;
  /** Optional relative path to adapter-level Markdown guidance (e.g. SKILL.md) */
  skillMdPath?: string;
}

// ---------------------------------------------------------------------------
// Adapter Entry Module (default export)
// ---------------------------------------------------------------------------

export type AdapterSource = "file" | "managed";

export interface AdapterRuntimeContext {
  adapterId: string;
  source: AdapterSource;
  manifest: AdapterManifest;
  config: Record<string, unknown>;
  toolConfig: Record<string, Record<string, unknown>>;
  getConfig: () => Record<string, unknown>;
  getToolConfig: (skillId?: string) => Record<string, unknown>;
  isToolEnabled: (skillId: string) => boolean;
  log: (level: "debug" | "info" | "warn" | "error", message: string, details?: Record<string, unknown>) => void;
}

export interface AdapterProfileMatchDraftWorkload {
  workloadKey: string;
  displayName: string;
  criticality: "low" | "medium" | "high";
  category?: string;
  summary?: string;
  evidence?: Record<string, unknown>;
}

export interface AdapterProfileMatchDraftAssurance {
  assuranceKey: string;
  workloadKey?: string;
  displayName: string;
  criticality: "low" | "medium" | "high";
  desiredState?: "running" | "stopped";
  checkIntervalSec?: number;
  monitorType?: string;
  requiredProtocols?: string[];
  rationale?: string;
  config?: Record<string, unknown>;
}

export interface AdapterProfileMatch {
  profileId: string;
  name?: string;
  adapterId?: string;
  kind?: "primary" | "fallback" | "supporting";
  confidence: number;
  summary: string;
  evidence?: Record<string, unknown>;
  requiredAccessMethods?: string[];
  requiredCredentialProtocols?: string[];
  defaultWorkloads?: AdapterProfileMatchDraftWorkload[];
  defaultAssurances?: AdapterProfileMatchDraftAssurance[];
}

export interface StewardAdapter {
  /** Called once when the adapter is loaded. */
  activate?: (context: AdapterRuntimeContext) => Promise<void> | void;
  /** Called when the adapter is unloaded / disabled. */
  deactivate?: (context: AdapterRuntimeContext) => Promise<void> | void;
  /** Called when adapter runtime config changes. */
  onConfigChange?: (
    config: Record<string, unknown>,
    toolConfig: Record<string, Record<string, unknown>>,
    context: AdapterRuntimeContext,
  ) => Promise<void> | void;
  /** Discovery provider — returns additional candidates during the discover phase. */
  discover?: (
    knownIps: string[],
    context: AdapterRuntimeContext,
  ) => Promise<DiscoveryCandidate[]> | DiscoveryCandidate[];
  /** Playbook definitions contributed by this adapter. Called once at load time. */
  playbooks?: (context: AdapterRuntimeContext) => PlaybookDefinition[];
  /** Device enrichment — called after discovery merge for each candidate. */
  enrich?: (
    candidate: DiscoveryCandidate,
    context: AdapterRuntimeContext,
  ) => Promise<DiscoveryCandidate> | DiscoveryCandidate;
  /** Additional management capabilities for the protocol negotiator. */
  capabilities?: (device: Device, context: AdapterRuntimeContext) => ManagementCapability[];
  /** Deterministic device profile matching for onboarding and management selection. */
  match?: (
    device: Device,
    context: AdapterRuntimeContext,
  ) => Promise<AdapterProfileMatch | AdapterProfileMatch[] | null | undefined> | AdapterProfileMatch | AdapterProfileMatch[] | null | undefined;
}

// ---------------------------------------------------------------------------
// Adapter Record (persisted in SQLite)
// ---------------------------------------------------------------------------

export interface AdapterRecord {
  id: string;
  source: AdapterSource;
  dirName: string;
  name: string;
  description: string;
  version: string;
  author: string;
  docsUrl?: string;
  skillMdPath?: string;
  skillMd?: AdapterSkillMarkdown;
  provides: AdapterCapability[];
  configSchema: AdapterConfigField[];
  config: Record<string, unknown>;
  toolSkills: AdapterToolSkill[];
  toolConfig: Record<string, Record<string, unknown>>;
  manifest: AdapterManifest;
  enabled: boolean;
  status: "loaded" | "error" | "disabled";
  error?: string;
  installedAt: string;
  updatedAt: string;
  location?: string;
}
