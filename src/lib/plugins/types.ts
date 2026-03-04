import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { Device, PlaybookDefinition } from "@/lib/state/types";
import type { ManagementCapability } from "@/lib/protocols/negotiator";

// ---------------------------------------------------------------------------
// Plugin Manifest (manifest.json)
// ---------------------------------------------------------------------------

export type PluginCapability =
  | "discovery"
  | "playbooks"
  | "enrichment"
  | "protocol";

export interface PluginManifest {
  /** Unique plugin ID, e.g. "com.example.unifi-discovery" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Semver version string */
  version: string;
  /** Plugin author */
  author: string;
  /** Relative path to the entry module (default: "index.js") */
  entry?: string;
  /** What this plugin provides */
  provides: PluginCapability[];
}

// ---------------------------------------------------------------------------
// Plugin Entry Module (default export)
// ---------------------------------------------------------------------------

export interface StewardPlugin {
  /** Called once when the plugin is loaded. */
  activate?: () => Promise<void> | void;
  /** Called when the plugin is unloaded / disabled. */
  deactivate?: () => Promise<void> | void;
  /** Discovery provider — returns additional candidates during the discover phase. */
  discover?: (knownIps: string[]) => Promise<DiscoveryCandidate[]>;
  /** Playbook definitions contributed by this plugin. Called once at load time. */
  playbooks?: () => PlaybookDefinition[];
  /** Device enrichment — called after discovery merge for each candidate. */
  enrich?: (candidate: DiscoveryCandidate) => Promise<DiscoveryCandidate>;
  /** Additional management capabilities for the protocol negotiator. */
  capabilities?: (device: Device) => ManagementCapability[];
}

// ---------------------------------------------------------------------------
// Plugin Record (persisted in SQLite)
// ---------------------------------------------------------------------------

export interface PluginRecord {
  id: string;
  dirName: string;
  name: string;
  description: string;
  version: string;
  author: string;
  provides: PluginCapability[];
  enabled: boolean;
  status: "loaded" | "error" | "disabled";
  error?: string;
  installedAt: string;
  updatedAt: string;
}
