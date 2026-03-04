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
  Device,
  DeviceBaseline,
  GraphEdge,
  GraphNode,
  Incident,
  LLMProvider,
  ProviderConfig,
  Recommendation,
  StewardState,
} from "@/lib/state/types";

const POLL_MS = 15_000;

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
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
  };

  // Mutations
  refresh: () => Promise<void>;
  runAgentCycle: () => Promise<{ summary: Record<string, number> }>;
  addDevice: (name: string, ip: string) => Promise<void>;
  updateIncidentStatus: (id: string, status: string) => Promise<void>;
  dismissRecommendation: (id: string) => Promise<void>;
  vaultAction: (action: "init" | "unlock" | "lock", passphrase?: string) => Promise<void>;
  saveProvider: (
    provider: LLMProvider,
    data: { enabled?: boolean; model?: string; apiKey?: string; baseUrl?: string },
  ) => Promise<void>;
  sendChat: (
    input: string,
    provider?: LLMProvider,
    model?: string,
  ) => Promise<{ provider: string; response: string }>;
}

const StewardContext = createContext<StewardContextValue | null>(null);

export function StewardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StewardState | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    try {
      const [s, v] = await Promise.all([
        fetchJson<StewardState>("/api/state"),
        fetchJson<VaultStatus>("/api/vault"),
      ]);
      setState(s);
      setVaultStatus(v);
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
    if (!state) return { devices: 0, online: 0, offline: 0, incidents: 0, recommendations: 0 };
    return {
      devices: state.devices.length,
      online: state.devices.filter((d) => d.status === "online").length,
      offline: state.devices.filter((d) => d.status === "offline").length,
      incidents: state.incidents.filter((i) => i.status !== "resolved").length,
      recommendations: state.recommendations.filter((r) => !r.dismissed).length,
    };
  }, [state]);

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

  const vaultAction = useCallback(
    async (action: "init" | "unlock" | "lock", passphrase?: string) => {
      await fetchJson("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, passphrase: action === "lock" ? undefined : passphrase }),
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
    async (input: string, provider?: LLMProvider, model?: string) => {
      return fetchJson<{ provider: string; response: string }>("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, provider, model }),
      });
    },
    [],
  );

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
      loading,
      error,
      overview,
      refresh,
      runAgentCycle,
      addDevice,
      updateIncidentStatus,
      dismissRecommendation,
      vaultAction,
      saveProvider,
      sendChat,
    }),
    [
      state,
      vaultStatus,
      loading,
      error,
      overview,
      refresh,
      runAgentCycle,
      addDevice,
      updateIncidentStatus,
      dismissRecommendation,
      vaultAction,
      saveProvider,
      sendChat,
    ],
  );

  return <StewardContext value={value}>{children}</StewardContext>;
}

export function useSteward(): StewardContextValue {
  const ctx = useContext(StewardContext);
  if (!ctx) throw new Error("useSteward must be used within StewardProvider");
  return ctx;
}
