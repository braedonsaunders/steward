"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  ActionLog,
  AgentRunRecord,
  AuthSettings,
  DailyDigest,
  Device,
  DeviceBaseline,
  GraphEdge,
  GraphNode,
  Incident,
  LLMProvider,
  MaintenanceWindow,
  PlaybookRun,
  PolicyRule,
  ProviderConfig,
  Recommendation,
  RuntimeSettings,
  StewardState,
  SystemSettings,
} from "@/lib/state/types";
import type { DeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { persistApiToken, withClientApiToken } from "@/lib/auth/client-token";

const POLL_MS = 15_000;

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, withClientApiToken(init));
  if (!res.ok) {
    const raw = await res.text();
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === "string") {
        message = parsed.error;
      } else if (typeof parsed.message === "string") {
        message = parsed.message;
      }
    } catch {
      // Use raw response text as-is.
    }
    throw new Error(message || `Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  keyCount: number;
}

export interface AdapterRecordClient {
  id: string;
  source: "file" | "managed";
  dirName: string;
  name: string;
  description: string;
  version: string;
  author: string;
  docsUrl?: string;
  provides: string[];
  configSchema: Array<{
    key: string;
    label: string;
    description?: string;
    type: "string" | "number" | "boolean" | "select" | "json";
    required?: boolean;
    default?: unknown;
    placeholder?: string;
    multiline?: boolean;
    secret?: boolean;
    min?: number;
    max?: number;
    options?: Array<{ label: string; value: string | number | boolean }>;
  }>;
  config: Record<string, unknown>;
  toolConfig: Record<string, Record<string, unknown>>;
  skillMdPath?: string;
  skillMd?: {
    path: string;
    content: string;
    truncated?: boolean;
  };
  toolSkills: Array<{
    id: string;
    name: string;
    description: string;
    category?: string;
    tags?: string[];
    enabledByDefault?: boolean;
    defaultConfig?: Record<string, unknown>;
    operationKinds?: string[];
    toolCall?: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
    skillMdPath?: string;
    skillMd?: {
      path: string;
      content: string;
      truncated?: boolean;
    };
  }>;
  enabled: boolean;
  status: "loaded" | "error" | "disabled";
  error?: string;
  installedAt: string;
  updatedAt: string;
  location?: string;
}

export interface AdapterPackageMutationPayload {
  manifest: Record<string, unknown>;
  entrySource: string;
  adapterSkillMd?: string;
  toolSkillMd?: Record<string, string>;
}

export interface AdapterPackageClient {
  adapter: AdapterRecordClient;
  manifest: Record<string, unknown>;
  entrySource: string;
  adapterSkillMd?: string;
  toolSkillMd: Record<string, string>;
  isBuiltin: boolean;
}

export interface StewardContextValue {
  // Data
  devices: Device[];
  baselines: DeviceBaseline[];
  incidents: Incident[];
  recommendations: Recommendation[];
  actions: ActionLog[];
  agentRuns: AgentRunRecord[];
  providerConfigs: ProviderConfig[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  vaultStatus: VaultStatus | null;
  policyRules: PolicyRule[];
  maintenanceWindows: MaintenanceWindow[];
  playbookRuns: PlaybookRun[];
  pendingApprovals: PlaybookRun[];
  latestDigest: DailyDigest | null;
  adapters: AdapterRecordClient[];
  runtimeSettings: RuntimeSettings;
  systemSettings: SystemSettings;
  authSettings: AuthSettings;

  // Status
  loading: boolean;
  error: string | null;

  // Derived
  overview: {
    devices: number;
    online: number;
    offline: number;
    incidents: number;
    recommendations: number;
    pendingApprovals: number;
    playbooksRunning: number;
  };

  // Mutations
  refresh: () => Promise<void>;
  runAgentCycle: () => Promise<{ summary: Record<string, number> }>;
  addDevice: (name: string, ip: string) => Promise<void>;
  renameDevice: (id: string, name: string) => Promise<void>;
  updateIncidentStatus: (id: string, status: string) => Promise<void>;
  dismissRecommendation: (id: string) => Promise<void>;
  saveProvider: (
    provider: LLMProvider,
    data: { enabled?: boolean; model?: string; apiKey?: string; baseUrl?: string },
  ) => Promise<void>;
  sendChat: (
    input: string,
    provider?: LLMProvider,
    model?: string,
    sessionId?: string,
  ) => Promise<{ provider: string; response: string }>;
  approveAction: (id: string) => Promise<void>;
  denyAction: (id: string, reason: string) => Promise<void>;
  triggerPlaybook: (playbookId: string, deviceId: string, incidentId?: string) => Promise<void>;
  generateDigest: () => Promise<void>;
  toggleAdapter: (id: string, enabled: boolean) => Promise<void>;
  reloadAdapters: () => Promise<void>;
  updateAdapterConfig: (
    id: string,
    payload: {
      config?: Record<string, unknown>;
      mode?: "merge" | "replace";
      toolConfig?: Record<string, Record<string, unknown>>;
      toolMode?: "merge" | "replace";
    },
  ) => Promise<AdapterRecordClient>;
  getAdapterPackage: (id: string) => Promise<AdapterPackageClient>;
  createAdapterPackage: (payload: AdapterPackageMutationPayload) => Promise<AdapterPackageClient>;
  updateAdapterPackage: (id: string, payload: AdapterPackageMutationPayload) => Promise<AdapterPackageClient>;
  deleteAdapterPackage: (id: string) => Promise<void>;
  saveRuntimeSettings: (settings: RuntimeSettings) => Promise<void>;
  saveSystemSettings: (settings: SystemSettings) => Promise<void>;
  setApiToken: (token: string | null) => Promise<void>;
  setDeviceAdoptionStatus: (id: string, status: DeviceAdoptionStatus) => Promise<void>;
}

const StewardContext = createContext<StewardContextValue | null>(null);

export function StewardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StewardState | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PlaybookRun[]>([]);
  const [latestDigest, setLatestDigest] = useState<DailyDigest | null>(null);
  const [adapters, setAdapters] = useState<AdapterRecordClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const [s, v, approvals, digest, adapterList] = await Promise.all([
        fetchJson<StewardState>("/api/state"),
        fetchJson<VaultStatus>("/api/vault"),
        fetchJson<PlaybookRun[]>("/api/approvals").catch(() => [] as PlaybookRun[]),
        fetchJson<DailyDigest>("/api/digest").catch(() => null),
        fetchJson<AdapterRecordClient[]>("/api/adapters").catch(() => [] as AdapterRecordClient[]),
      ]);
      setState(s);
      setVaultStatus(v);
      setPendingApprovals(approvals);
      setLatestDigest(digest);
      setAdapters(adapterList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
    const id = setInterval(() => void loadState(), POLL_MS);
    return () => clearInterval(id);
  }, [loadState]);

  const overview = useMemo(() => {
    if (!state) return { devices: 0, online: 0, offline: 0, incidents: 0, recommendations: 0, pendingApprovals: 0, playbooksRunning: 0 };
    return {
      devices: state.devices.length,
      online: state.devices.filter((d) => d.status === "online").length,
      offline: state.devices.filter((d) => d.status === "offline").length,
      incidents: state.incidents.filter((i) => i.status !== "resolved").length,
      recommendations: state.recommendations.filter((r) => !r.dismissed).length,
      pendingApprovals: pendingApprovals.length,
      playbooksRunning: (state.playbookRuns ?? []).filter((r) => ["preflight", "executing", "verifying"].includes(r.status)).length,
    };
  }, [state, pendingApprovals]);

  const refresh = useCallback(async () => {
    await loadState();
  }, [loadState]);

  const runAgentCycle = useCallback(async () => {
    const result = await fetchJson<{ ok: boolean; summary: Record<string, number> }>(
      "/api/agent/run",
      { method: "POST" },
    );
    await loadState();
    return result;
  }, [loadState]);

  const addDevice = useCallback(
    async (name: string, ip: string) => {
      await fetchJson("/api/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ip }),
      });
      await loadState();
    },
    [loadState],
  );

  const renameDevice = useCallback(
    async (id: string, name: string) => {
      await fetchJson(`/api/devices/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadState();
    },
    [loadState],
  );

  const updateIncidentStatus = useCallback(
    async (id: string, status: string) => {
      await fetchJson("/api/incidents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      await loadState();
    },
    [loadState],
  );

  const dismissRecommendation = useCallback(
    async (id: string) => {
      await fetchJson("/api/recommendations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, dismissed: true }),
      });
      await loadState();
    },
    [loadState],
  );

  const saveProvider = useCallback(
    async (
      provider: LLMProvider,
      data: { enabled?: boolean; model?: string; apiKey?: string; baseUrl?: string },
    ) => {
      await fetchJson("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          ...data,
          apiKey: data.apiKey || undefined,
          baseUrl: data.baseUrl || undefined,
        }),
      });
      await loadState();
    },
    [loadState],
  );

  const sendChat = useCallback(
    async (input: string, provider?: LLMProvider, model?: string, sessionId?: string) => {
      return fetchJson<{ provider: string; response: string }>("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, provider, model, sessionId }),
      });
    },
    [],
  );

  const approveAction = useCallback(
    async (id: string) => {
      await fetchJson(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      await loadState();
    },
    [loadState],
  );

  const denyAction = useCallback(
    async (id: string, reason: string) => {
      await fetchJson(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "deny", reason }),
      });
      await loadState();
    },
    [loadState],
  );

  const triggerPlaybook = useCallback(
    async (playbookId: string, deviceId: string, incidentId?: string) => {
      await fetchJson("/api/playbooks/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbookId, deviceId, incidentId }),
      });
      await loadState();
    },
    [loadState],
  );

  const generateDigest = useCallback(async () => {
    await fetchJson("/api/digest", { method: "POST" });
    await loadState();
  }, [loadState]);

  const toggleAdapter = useCallback(
    async (id: string, enabled: boolean) => {
      await fetchJson(`/api/adapters/${id}/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await loadState();
    },
    [loadState],
  );

  const reloadAdapters = useCallback(async () => {
    await fetchJson("/api/adapters/reload", { method: "POST" });
    await loadState();
  }, [loadState]);

  const updateAdapterConfig = useCallback(
    async (
      id: string,
      payload: {
        config?: Record<string, unknown>;
        mode?: "merge" | "replace";
        toolConfig?: Record<string, Record<string, unknown>>;
        toolMode?: "merge" | "replace";
      },
    ) => {
      const result = await fetchJson<{ ok: boolean; adapter: AdapterRecordClient }>(
        `/api/adapters/${id}/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      await loadState();
      return result.adapter;
    },
    [loadState],
  );

  const getAdapterPackage = useCallback(async (id: string) => {
    const result = await fetchJson<AdapterPackageClient>(`/api/adapters/${id}`);
    return result;
  }, []);

  const createAdapterPackage = useCallback(
    async (payload: AdapterPackageMutationPayload) => {
      const result = await fetchJson<{ ok: boolean; package: AdapterPackageClient }>("/api/adapters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await loadState();
      return result.package;
    },
    [loadState],
  );

  const updateAdapterPackage = useCallback(
    async (id: string, payload: AdapterPackageMutationPayload) => {
      const result = await fetchJson<{ ok: boolean; package: AdapterPackageClient }>(`/api/adapters/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      await loadState();
      return result.package;
    },
    [loadState],
  );

  const deleteAdapterPackage = useCallback(
    async (id: string) => {
      await fetchJson<{ ok: boolean }>(`/api/adapters/${id}`, {
        method: "DELETE",
      });
      await loadState();
    },
    [loadState],
  );

  const saveRuntimeSettings = useCallback(async (settings: RuntimeSettings) => {
    await fetchJson("/api/settings/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    await loadState();
  }, [loadState]);

  const saveSystemSettings = useCallback(async (settings: SystemSettings) => {
    await fetchJson("/api/settings/system", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    await loadState();
  }, [loadState]);

  const setApiToken = useCallback(async (token: string | null) => {
    await fetchJson("/api/settings/auth-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    persistApiToken(token?.trim() ? token.trim() : null);
    await loadState();
  }, [loadState]);

  const setDeviceAdoptionStatus = useCallback(async (id: string, status: DeviceAdoptionStatus) => {
    await fetchJson(`/api/devices/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adoptionStatus: status }),
    });
    await loadState();
  }, [loadState]);

  const value = useMemo<StewardContextValue>(
    () => ({
      devices: state?.devices ?? [],
      baselines: state?.baselines ?? [],
      incidents: state?.incidents ?? [],
      recommendations: state?.recommendations ?? [],
      actions: state?.actions ?? [],
      agentRuns: state?.agentRuns ?? [],
      providerConfigs: state?.providerConfigs ?? [],
      graphNodes: state?.graph?.nodes ?? [],
      graphEdges: state?.graph?.edges ?? [],
      vaultStatus,
      policyRules: state?.policyRules ?? [],
      maintenanceWindows: state?.maintenanceWindows ?? [],
      playbookRuns: state?.playbookRuns ?? [],
      pendingApprovals,
      latestDigest,
      adapters,
      runtimeSettings: state?.runtimeSettings ?? {
        agentIntervalMs: 120_000,
        deepScanIntervalMs: 30 * 60 * 1000,
        incrementalActiveTargets: 32,
        deepActiveTargets: 256,
        incrementalPortScanHosts: 16,
        deepPortScanHosts: 96,
        llmDiscoveryLimit: 10,
        incrementalFingerprintTargets: 6,
        deepFingerprintTargets: 24,
        enableMdnsDiscovery: true,
        enableSsdpDiscovery: true,
        enableSnmpProbe: true,
        ouiUpdateIntervalMs: 7 * 24 * 60 * 60 * 1000,
        laneBEnabled: false,
        laneBAllowedEnvironments: ["lab", "dev"],
        laneBAllowedFamilies: ["service-recovery", "disk-cleanup", "backup-retry"],
        laneCMutationsInLab: false,
        laneCMutationsInProd: false,
        mutationRequireDryRunWhenSupported: true,
        approvalTtlClassBMs: 2 * 60 * 60 * 1000,
        approvalTtlClassCMs: 60 * 60 * 1000,
        approvalTtlClassDMs: 30 * 60 * 1000,
        quarantineThresholdCount: 3,
        quarantineThresholdWindowMs: 10 * 60 * 1000,
      },
      systemSettings: state?.systemSettings ?? {
        nodeIdentity: "steward-local",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/Toronto",
        digestScheduleEnabled: true,
        digestHourLocal: 9,
        digestMinuteLocal: 0,
        upgradeChannel: "stable",
      },
      authSettings: state?.authSettings ?? {
        apiTokenEnabled: false,
        mode: "hybrid",
        sessionTtlHours: 12,
        oidc: {
          enabled: false,
          issuer: "",
          clientId: "",
          scopes: "openid profile email",
          autoProvision: true,
          defaultRole: "Operator",
          clientSecretConfigured: false,
        },
        ldap: {
          enabled: false,
          url: "",
          baseDn: "",
          bindDn: "",
          userFilter: "(&(objectClass=person)(uid={{username}}))",
          uidAttribute: "uid",
          autoProvision: true,
          defaultRole: "Operator",
          bindPasswordConfigured: false,
        },
      },
      loading,
      error,
      overview,
      refresh,
      runAgentCycle,
      addDevice,
      renameDevice,
      updateIncidentStatus,
      dismissRecommendation,
      saveProvider,
      sendChat,
      approveAction,
      denyAction,
      triggerPlaybook,
      generateDigest,
      toggleAdapter,
      reloadAdapters,
      updateAdapterConfig,
      getAdapterPackage,
      createAdapterPackage,
      updateAdapterPackage,
      deleteAdapterPackage,
      saveRuntimeSettings,
      saveSystemSettings,
      setApiToken,
      setDeviceAdoptionStatus,
    }),
    [
      state,
      vaultStatus,
      pendingApprovals,
      latestDigest,
      adapters,
      loading,
      error,
      overview,
      refresh,
      runAgentCycle,
      addDevice,
      renameDevice,
      updateIncidentStatus,
      dismissRecommendation,
      saveProvider,
      sendChat,
      approveAction,
      denyAction,
      triggerPlaybook,
      generateDigest,
      toggleAdapter,
      reloadAdapters,
      updateAdapterConfig,
      getAdapterPackage,
      createAdapterPackage,
      updateAdapterPackage,
      deleteAdapterPackage,
      saveRuntimeSettings,
      saveSystemSettings,
      setApiToken,
      setDeviceAdoptionStatus,
    ],
  );

  return <StewardContext value={value}>{children}</StewardContext>;
}

export function useSteward(): StewardContextValue {
  const ctx = useContext(StewardContext);
  if (!ctx) throw new Error("useSteward must be used within StewardProvider");
  return ctx;
}
