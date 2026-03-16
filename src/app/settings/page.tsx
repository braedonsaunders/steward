"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  ExternalLink,
  Globe,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import {
  constrainedDiscoveryPhases,
  deferredDiscoveryPhases,
  discoveryEnrichmentPhaseLabel,
  formatDurationMs,
  parseDiscoveryDiagnostics,
  parseDiscoveryEnrichmentSummary,
  phaseStatusLabel,
  slowestDiscoveryPhase,
} from "@/lib/discovery/diagnostics";
import { PROVIDER_REGISTRY, type ProviderMeta } from "@/lib/llm/registry";
import {
  requiresWebResearchApiKey,
  WEB_RESEARCH_PROVIDER_META,
  WEB_RESEARCH_PROVIDER_ORDER,
} from "@/lib/assistant/web-research-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
// Switch removed — dropdown selection = active provider, no separate toggle
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type {
  ControlPlaneQueueLane,
  LLMProvider,
  RuntimeSettings,
  WebResearchProvider,
} from "@/lib/state/types";
import { formatIncidentType } from "@/lib/incidents/utils";
import { cn } from "@/lib/utils";
import { withApiTokenQuery, withClientApiToken } from "@/lib/auth/client-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}

const DISCOVERY_ENRICHMENT_KIND_PREFIX = "discovery.enrichment.";

const isDiscoveryEnrichmentLane = (kind: string): boolean =>
  kind.startsWith(DISCOVERY_ENRICHMENT_KIND_PREFIX);

const queueLaneLabel = (kind: string): string => {
  if (kind === "scanner.discovery") {
    return "Core scanner";
  }
  if (kind === "monitor.execute") {
    return "Monitor execution";
  }
  if (kind === "agent.wake") {
    return "Agent wake";
  }
  if (kind === "agent.assurance") {
    return "Agent assurance routing";
  }
  if (kind === "discovery.enrichment.fingerprint") {
    return "Discovery enrichment: service fingerprinting";
  }
  if (kind === "discovery.enrichment.nmap") {
    return "Discovery enrichment: deep nmap fingerprinting";
  }
  if (kind === "discovery.enrichment.browser") {
    return "Discovery enrichment: browser observation";
  }
  if (kind === "discovery.enrichment.hostname") {
    return "Discovery enrichment: hostname enrichment";
  }
  return kind;
};

const summarizeQueueLanes = (lanes: ControlPlaneQueueLane[]): {
  pending: number;
  processing: number;
  completed: number;
} => lanes.reduce((summary, lane) => ({
  pending: summary.pending + lane.pending,
  processing: summary.processing + lane.processing,
  completed: summary.completed + lane.completed,
}), {
  pending: 0,
  processing: 0,
  completed: 0,
});

const categoryIcon = {
  cloud: Cloud,
  local: HardDrive,
  aggregator: Globe,
} as const;

const categoryLabel = {
  cloud: "Cloud",
  local: "Local",
  aggregator: "Aggregator",
} as const;

// Group registry by category
const groupedProviders = PROVIDER_REGISTRY.reduce(
  (acc, p) => {
    if (!acc[p.category]) acc[p.category] = [];
    acc[p.category].push(p);
    return acc;
  },
  {} as Record<string, ProviderMeta[]>,
);

const categoryOrder = ["cloud", "local", "aggregator"] as const;

const webResearchFallbackStrategyOptions: Array<{
  value: RuntimeSettings["webResearchFallbackStrategy"];
  label: string;
}> = [
  { value: "prefer_non_key", label: "Auto (prefer no-key fallbacks)" },
  { value: "key_only", label: "Auto (keyed providers only)" },
  { value: "selected_only", label: "Selected provider only" },
];

function settingsSignature<T>(value: T): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Providers Section
// ---------------------------------------------------------------------------

interface ProviderDraft {
  enabled: boolean;
  model: string;
  apiKey: string;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// OpenAI OAuth (localhost:1455 callback server)
// ---------------------------------------------------------------------------

function OpenAIOAuthSection({
  disabled = false,
  disabledReason,
  initialConnected = false,
  onDisconnect,
  onConnected,
}: {
  disabled?: boolean;
  disabledReason?: string;
  initialConnected?: boolean;
  onDisconnect?: () => Promise<void>;
  onConnected?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<"idle" | "waiting" | "complete" | "error" | "disconnecting">(
    initialConnected ? "complete" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const effectiveStatus = status === "idle" && initialConnected ? "complete" : status;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startFlow = useCallback(async () => {
    if (disabled) {
      setStatus("error");
      setError(disabledReason ?? "Vault must be initialized and unlocked first.");
      return;
    }

    setStatus("waiting");
    setError(null);

    try {
      const res = await fetch("/api/providers/oauth/openai/start", withClientApiToken({ method: "POST" }));
      const data = (await res.json()) as { url?: string; error?: string };

      if (!res.ok || !data.url) {
        setStatus("error");
        setError(data.error ?? "Failed to start OAuth flow");
        return;
      }

      window.open(data.url, "_blank");

      // Poll for completion
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch("/api/providers/oauth/openai/status", withClientApiToken());
          const statusData = (await statusRes.json()) as {
            status: "pending" | "complete" | "error";
            error?: string;
          };

          if (statusData.status === "complete") {
            setStatus("complete");
            stopPolling();
            void onConnected?.();
          } else if (statusData.status === "error") {
            setStatus("error");
            setError(statusData.error ?? "OAuth flow failed");
            stopPolling();
          }
        } catch {
          // Ignore polling errors
        }
      }, 2000);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to start OAuth flow");
    }
  }, [disabled, disabledReason, onConnected, stopPolling]);

  const handleDisconnect = useCallback(async () => {
    setStatus("disconnecting");
    setError(null);
    try {
      if (onDisconnect) await onDisconnect();
      setStatus("idle");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    }
  }, [onDisconnect]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
        <div>
          <p className="text-sm font-medium">OAuth (ChatGPT Plus)</p>
          <p className="text-xs text-muted-foreground">
            Sign in with your OpenAI account
          </p>
        </div>
        {effectiveStatus === "waiting" ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Waiting...
          </Button>
        ) : effectiveStatus === "disconnecting" ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Disconnecting...
          </Button>
        ) : effectiveStatus === "complete" ? (
          <div className="flex items-center gap-2">
            <Badge variant="default" className="text-xs">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Connected
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => void handleDisconnect()}
            >
              <XCircle className="mr-1 h-3 w-3" />
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void startFlow()}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Connect
          </Button>
        )}
      </div>
      {effectiveStatus === "error" && error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anthropic OAuth (code-paste flow)
// ---------------------------------------------------------------------------

function AnthropicOAuthSection({
  disabled = false,
  disabledReason,
  initialConnected = false,
  onDisconnect,
  onConnected,
}: {
  disabled?: boolean;
  disabledReason?: string;
  initialConnected?: boolean;
  onDisconnect?: () => Promise<void>;
  onConnected?: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<"idle" | "waiting" | "exchanging" | "complete" | "error" | "disconnecting">(
    initialConnected ? "complete" : "idle",
  );

  const [pastedCode, setPastedCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const effectivePhase = phase === "idle" && initialConnected ? "complete" : phase;

  const startFlow = useCallback(async () => {
    if (disabled) {
      setPhase("error");
      setError(disabledReason ?? "Vault must be initialized and unlocked first.");
      return;
    }

    setPhase("waiting");
    setError(null);

    try {
      const res = await fetch("/api/providers/oauth/anthropic/start", withClientApiToken({ method: "POST" }));
      const data = (await res.json()) as { url?: string; error?: string };

      if (!res.ok || !data.url) {
        setPhase("error");
        setError(data.error ?? "Failed to start OAuth flow");
        return;
      }

      window.open(data.url, "_blank");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Failed to start OAuth flow");
    }
  }, [disabled, disabledReason]);

  const exchangeCode = useCallback(async () => {
    if (!pastedCode.trim()) return;
    if (disabled) {
      setPhase("error");
      setError(disabledReason ?? "Vault must be initialized and unlocked first.");
      return;
    }
    setPhase("exchanging");
    setError(null);

    try {
      const res = await fetch("/api/providers/oauth/anthropic/exchange", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pastedCode.trim() }),
      }));
      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setPhase("error");
        setError(typeof data.error === "string" ? data.error : "Code exchange failed");
        return;
      }

      setPhase("complete");
      setPastedCode("");
      await onConnected?.();
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Code exchange failed");
    }
  }, [disabled, disabledReason, onConnected, pastedCode]);

  const handleDisconnect = useCallback(async () => {
    setPhase("disconnecting");
    setError(null);
    try {
      if (onDisconnect) await onDisconnect();
      setPhase("idle");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    }
  }, [onDisconnect]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
        <div>
          <p className="text-sm font-medium">OAuth (Claude Account)</p>
          <p className="text-xs text-muted-foreground">
            Create an API key via your Anthropic account
          </p>
        </div>
        {effectivePhase === "disconnecting" ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Disconnecting...
          </Button>
        ) : effectivePhase === "complete" ? (
          <div className="flex items-center gap-2">
            <Badge variant="default" className="text-xs">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Key Created
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => void handleDisconnect()}
            >
              <XCircle className="mr-1 h-3 w-3" />
              Disconnect
            </Button>
          </div>
        ) : effectivePhase !== "waiting" && effectivePhase !== "exchanging" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void startFlow()}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Connect
          </Button>
        ) : null}
      </div>

      {(effectivePhase === "waiting" || effectivePhase === "exchanging") && (
        <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Paste the authorization code from the Anthropic page:
          </p>
          <div className="flex gap-2">
            <Input
              value={pastedCode}
              onChange={(e) => setPastedCode(e.target.value)}
              placeholder="code#state"
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              onClick={() => void exchangeCode()}
              disabled={disabled || !pastedCode.trim() || effectivePhase === "exchanging"}
              title={disabled ? disabledReason : undefined}
            >
              {effectivePhase === "exchanging" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Submit"
              )}
            </Button>
          </div>
        </div>
      )}

      {effectivePhase === "error" && error && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic redirect OAuth (Google) / OpenRouter
// ---------------------------------------------------------------------------

function RedirectOAuthSection({
  provider,
  label,
  disabled = false,
  disabledReason,
  initialConnected = false,
  onDisconnect,
}: {
  provider: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  initialConnected?: boolean;
  onDisconnect?: () => Promise<void>;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [connected, setConnected] = useState(initialConnected);

  useEffect(() => {
    setConnected(initialConnected);
  }, [initialConnected]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      if (onDisconnect) await onDisconnect();
      setConnected(false);
    } catch {
      // Ignore errors
    } finally {
      setDisconnecting(false);
    }
  }, [onDisconnect]);

  return (
    <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
      <div>
        <p className="text-sm font-medium">OAuth</p>
        <p className="text-xs text-muted-foreground">
          Connect via {label} OAuth flow
        </p>
      </div>
      {disconnecting ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          Disconnecting...
        </Button>
      ) : connected ? (
        <div className="flex items-center gap-2">
          <Badge variant="default" className="text-xs">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Connected
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => void handleDisconnect()}
          >
            <XCircle className="mr-1 h-3 w-3" />
            Disconnect
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => {
            window.open(
              withApiTokenQuery(`/api/providers/oauth/start?provider=${provider}`),
              "_blank",
              "noopener,noreferrer",
            );
          }}
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          Connect
        </Button>
      )}
    </div>
  );
}

function ProvidersSection() {
  const { providerConfigs, refresh, saveProvider, loading: stateLoading } = useSteward();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<LLMProvider>("openai");
  const [draft, setDraft] = useState<ProviderDraft>({
    enabled: false,
    model: "",
    apiKey: "",
    baseUrl: "",
  });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "ok" | "error";
    message: string;
  } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const didInitializeSelection = useRef(false);
  const modelsRequestSeq = useRef(0);
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({});

  // Vault auto-initializes — no manual setup needed
  const vaultReady = true;

  // Fetch credential status on mount to show "Connected" for existing OAuth tokens
  const refreshCredentialStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/providers/status", withClientApiToken());
      const data = (await res.json()) as Record<string, boolean>;
      setCredentialStatus(data);
    } catch {
      // Ignore credential status errors.
    }
  }, []);

  useEffect(() => {
    void refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  // Handle OAuth callback query params
  const oauthStatus = searchParams.get("oauth");
  const oauthProvider = searchParams.get("provider") as LLMProvider | null;
  const oauthReason = searchParams.get("reason");

  // Auto-select the provider that just completed OAuth
  useEffect(() => {
    if (oauthProvider) {
      setSelectedId(oauthProvider);
      didInitializeSelection.current = true;
      void refreshCredentialStatus();
      void refresh();
    }
  }, [oauthProvider, refresh, refreshCredentialStatus]);

  // On initial load, default to currently active provider instead of hard-coded OpenAI.
  useEffect(() => {
    if (didInitializeSelection.current) {
      return;
    }

    const activeProvider = providerConfigs.find((config) => config.enabled)?.provider;
    if (!activeProvider) {
      return;
    }

    setSelectedId(activeProvider);
    didInitializeSelection.current = true;
  }, [providerConfigs]);

  const selectedMeta = useMemo(
    () => PROVIDER_REGISTRY.find((p) => p.id === selectedId),
    [selectedId],
  );

  const selectedConfig = useMemo(
    () => providerConfigs.find((c) => c.provider === selectedId),
    [providerConfigs, selectedId],
  );

  // Fetch available models
  const fetchModels = useCallback(
    (provider: LLMProvider, refresh = false) => {
      const requestSeq = ++modelsRequestSeq.current;
      setModelsLoading(true);
      setModelsError(null);
      const url = `/api/providers/models?provider=${provider}${refresh ? "&refresh=1" : ""}`;
      fetch(url, withClientApiToken())
        .then(async (res) => {
          const data = (await res.json()) as { models?: string[]; error?: string };
          if (requestSeq !== modelsRequestSeq.current) {
            return;
          }

          setAvailableModels(Array.isArray(data.models) ? data.models : []);
          setModelsError(res.ok ? null : (typeof data.error === "string" ? data.error : "Failed to load models from provider API."));
          setModelsLoading(false);
        })
        .catch(() => {
          if (requestSeq !== modelsRequestSeq.current) {
            return;
          }

          setAvailableModels([]);
          setModelsError("Failed to load models from provider API.");
          setModelsLoading(false);
        });
    },
    [],
  );

  // Fetch models when provider changes
  useEffect(() => {
    setAvailableModels([]);
    setModelsError(null);
    fetchModels(selectedId);
  }, [selectedId, fetchModels]);

  // Sync draft when provider selection or config changes
  useEffect(() => {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === selectedId);
    setDraft({
      enabled: selectedConfig?.enabled ?? true,
      model: selectedConfig?.model ?? "",
      apiKey: "",
      baseUrl: selectedConfig?.baseUrl ?? meta?.defaultBaseUrl ?? "",
    });
    setFeedback(null);
  }, [selectedId, selectedConfig]);

  useEffect(() => {
    if (stateLoading) {
      return;
    }

    setDraft((prev) => {
      if (!availableModels.length) {
        return prev;
      }

      if (!prev.model) {
        return { ...prev, model: availableModels[0] };
      }

      if (availableModels.includes(prev.model)) {
        return prev;
      }

      return { ...prev, model: availableModels[0] };
    });
  }, [availableModels, stateLoading]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const hasDraftApiKey = draft.apiKey.trim().length > 0;
      if (draft.model) {
        if (!availableModels.includes(draft.model)) {
          throw new Error("Select a model returned directly by the provider API.");
        }
      } else if (!hasDraftApiKey) {
        throw new Error("Select a model returned directly by the provider API.");
      }

      // The currently selected provider from the dropdown IS the active one.
      // Always enable it — the API will disable all others automatically.
      await saveProvider(selectedId, {
        enabled: true,
        model: draft.model || undefined,
        apiKey: draft.apiKey || undefined,
        baseUrl: draft.baseUrl || undefined,
      });
      setDraft((prev) => ({ ...prev, apiKey: "" }));
      setFeedback({ type: "ok", message: "Configuration saved." });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to save.",
      });
    } finally {
      setSaving(false);
    }
  }, [availableModels, selectedId, draft, saveProvider]);

  // Disconnect handler — removes all credentials from vault and refreshes status
  const handleDisconnect = useCallback(
    async (provider: LLMProvider) => {
      const res = await fetch("/api/providers/disconnect", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      }));
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to disconnect");
      }
      // Refresh credential status
      await refreshCredentialStatus();
      await refresh();
    },
    [refresh, refreshCredentialStatus],
  );

  const handleConnected = useCallback(async () => {
    await refreshCredentialStatus();
    await refresh();
  }, [refresh, refreshCredentialStatus]);

  const showBaseUrl = selectedMeta?.openaiCompatible || selectedMeta?.category === "local";
  const showApiKey = selectedMeta?.requiresApiKey !== false;
  const showOAuth = selectedMeta?.supportsOAuth === true;

  return (
    <div className="space-y-6">
      {/* Vault auto-initializes — no alert needed */}

      {/* OAuth success/error banner */}
      {oauthStatus === "success" && oauthProvider && (
        <Alert>
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <AlertDescription className="text-sm">
            Successfully connected {PROVIDER_REGISTRY.find((p) => p.id === oauthProvider)?.label ?? oauthProvider} via OAuth.
          </AlertDescription>
        </Alert>
      )}
      {oauthStatus === "error" && oauthProvider && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            OAuth failed for {PROVIDER_REGISTRY.find((p) => p.id === oauthProvider)?.label ?? oauthProvider}
            {oauthReason ? `: ${oauthReason}` : "."}
          </AlertDescription>
        </Alert>
      )}

      <Card className="bg-card/60">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Configure Provider</CardTitle>
          <CardDescription>
            Select a provider to configure. Supports cloud APIs, local inference, and aggregators via the Vercel AI SDK.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Provider dropdown */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select
              value={selectedId}
              onValueChange={(v) => setSelectedId(v as LLMProvider)}
              disabled={!vaultReady}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categoryOrder.map((cat) => {
                  const providers = groupedProviders[cat];
                  if (!providers?.length) return null;
                  const Icon = categoryIcon[cat];
                  return (
                    <SelectGroup key={cat}>
                      <SelectLabel className="flex items-center gap-1.5">
                        <Icon className="h-3 w-3" />
                        {categoryLabel[cat]}
                      </SelectLabel>
                      {providers.map((p) => {
                        const cfg = providerConfigs.find(
                          (c) => c.provider === p.id,
                        );
                        return (
                          <SelectItem key={p.id} value={p.id}>
                            <span className="flex items-center gap-2">
                              <span
                                className={cn(
                                  "inline-block h-1.5 w-1.5 rounded-full",
                                  cfg?.enabled
                                    ? "bg-emerald-500"
                                    : "bg-muted-foreground/30",
                                )}
                              />
                              {p.label}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Provider description */}
          {selectedMeta && (
            <div className="flex items-center gap-3 rounded-lg border bg-background/50 px-4 py-3">
              {(() => {
                const Icon = categoryIcon[selectedMeta.category];
                return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />;
              })()}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{selectedMeta.label}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedMeta.description}
                </p>
              </div>
              <Badge
                variant={
                  selectedMeta.category === "local"
                    ? "secondary"
                    : selectedMeta.category === "aggregator"
                      ? "outline"
                      : "default"
                }
                className="shrink-0 text-[10px]"
              >
                {categoryLabel[selectedMeta.category]}
              </Badge>
            </div>
          )}

          <Separator />

          {/* Model */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="provider-model" className="text-xs text-muted-foreground">
                Model
              </Label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fetchModels(selectedId, true)}
                  disabled={modelsLoading || !vaultReady}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  title="Refresh models"
                >
                  <RefreshCw className={cn("h-3 w-3", modelsLoading && "animate-spin")} />
                </button>
              </div>
            </div>
            <Select
              value={draft.model || undefined}
              disabled={!vaultReady || modelsLoading || availableModels.length === 0}
              onValueChange={(v) => setDraft((prev) => ({ ...prev, model: v }))}
            >
              <SelectTrigger id="provider-model" className="w-full">
                {modelsLoading ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading...
                  </span>
                ) : (
                  <SelectValue placeholder={availableModels.length ? "Select a model" : "No models returned by provider API"} />
                )}
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Models are retrieved directly from the selected provider API.
            </p>
            {modelsError && (
              <p className="text-[10px] text-destructive">
                {modelsError}
              </p>
            )}
          </div>

          {/* Authentication */}
          {(showApiKey || showOAuth) && (
            <>
              <Separator />
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Authentication
                </p>

                {/* API Key */}
                {showApiKey && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="provider-key" className="text-xs text-muted-foreground">
                        API Key
                      </Label>
                      {selectedMeta?.consoleUrl && (
                        <a
                          href={selectedMeta.consoleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[10px] text-primary hover:underline"
                        >
                          Get API Key
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      )}
                    </div>
                    <Input
                      id="provider-key"
                      type="password"
                      value={draft.apiKey}
                      onChange={(e) =>
                        setDraft((prev) => ({ ...prev, apiKey: e.target.value }))
                      }
                      disabled={!vaultReady}
                      placeholder={
                        selectedMeta?.apiKeyPlaceholder || "Enter API key"
                      }
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Stored securely in the encrypted vault.
                    </p>
                  </div>
                )}

                {/* OAuth */}
                {showOAuth && (
                  <>
                    {showApiKey && (
                      <div className="relative flex items-center py-1">
                        <Separator className="flex-1" />
                        <span className="px-3 text-[10px] uppercase text-muted-foreground">or</span>
                        <Separator className="flex-1" />
                      </div>
                    )}
                    {selectedMeta?.oauthMethod === "localhost" && (
                      <OpenAIOAuthSection
                        disabled={false}
                        initialConnected={!!credentialStatus[selectedId]}
                        onConnected={handleConnected}
                        onDisconnect={() => handleDisconnect(selectedId)}
                      />
                    )}
                    {selectedMeta?.oauthMethod === "code-paste" && (
                      <AnthropicOAuthSection
                        disabled={false}
                        initialConnected={!!credentialStatus[selectedId]}
                        onConnected={handleConnected}
                        onDisconnect={() => handleDisconnect(selectedId)}
                      />
                    )}
                    {(selectedMeta?.oauthMethod === "redirect" || selectedMeta?.oauthMethod === "openrouter") && (
                      <RedirectOAuthSection
                        provider={selectedId}
                        label={selectedMeta.label}
                        disabled={false}
                        initialConnected={!!credentialStatus[selectedId]}
                        onDisconnect={() => handleDisconnect(selectedId)}
                      />
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* No auth needed notice for local providers */}
          {!showApiKey && !showOAuth && (
            <>
              <Separator />
              <p className="text-xs text-muted-foreground">
                No authentication required. Make sure the local server is running.
              </p>
            </>
          )}

          {/* Base URL (for OpenAI-compatible and local providers) */}
          {showBaseUrl && (
            <>
              <Separator />
              <div className="space-y-1.5">
                <Label htmlFor="provider-url" className="text-xs text-muted-foreground">
                  Base URL
                </Label>
                <Input
                  id="provider-url"
                  value={draft.baseUrl}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  disabled={!vaultReady}
                  placeholder={
                    selectedMeta?.defaultBaseUrl || "http://localhost:8080/v1"
                  }
                />
                {selectedMeta?.category === "local" && (
                  <p className="text-[10px] text-muted-foreground">
                    OpenAI-compatible endpoint
                  </p>
                )}
              </div>
            </>
          )}

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Save
                </>
              )}
            </Button>
          </div>

          {/* Feedback */}
          {feedback && (
            <Alert
              variant={feedback.type === "error" ? "destructive" : "default"}
            >
              <AlertDescription className="text-xs">
                {feedback.message}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vault Section
// ---------------------------------------------------------------------------

function VaultSection() {
  const { vaultStatus } = useSteward();

  const keyCount = vaultStatus?.keyCount ?? 0;
  const ready = vaultStatus?.unlocked ?? false;
  const protection = (vaultStatus as Record<string, unknown> | null)?.protection as string | undefined;

  return (
    <div className="space-y-4">
      <Card className="bg-card/60">
        <CardHeader>
          <CardTitle className="text-base">Vault Status</CardTitle>
          <CardDescription>
            Encrypted secret storage for API keys and credentials.
            Keys are protected automatically using {protection ?? "OS-native encryption"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-lg border bg-background/50 px-4 py-3">
            {ready ? (
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
            ) : (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">State</p>
                <Badge variant={ready ? "default" : "secondary"} className="text-[10px]">
                  {ready ? "Active" : "Initializing..."}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {keyCount} secret{keyCount !== 1 ? "s" : ""} stored
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General Section
// ---------------------------------------------------------------------------

type GeneralTabValue =
  | "agent"
  | "discovery"
  | "fingerprinting"
  | "observation"
  | "web-research"
  | "alerts"
  | "system";

const GENERAL_TAB_VALUES: GeneralTabValue[] = [
  "agent",
  "discovery",
  "fingerprinting",
  "observation",
  "web-research",
  "alerts",
  "system",
];

type SettingsTabValue = "providers" | "vault" | GeneralTabValue;

function isGeneralTabValue(value: SettingsTabValue): value is GeneralTabValue {
  return GENERAL_TAB_VALUES.includes(value as GeneralTabValue);
}

function SettingsNumberField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function SettingsToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function RuntimeSaveButton({
  saving,
  label,
  onClick,
}: {
  saving: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} disabled={saving}>
      {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Settings2 className="mr-1.5 h-4 w-4" />}
      {saving ? "Saving..." : label}
    </Button>
  );
}

function GeneralSection({ tab }: { tab: GeneralTabValue }) {
  const {
    scannerRuns,
    agentRuns,
    controlPlane,
    runAgentCycle,
    runtimeSettings,
    saveRuntimeSettings,
    systemSettings,
    saveSystemSettings,
    authSettings,
    setApiToken,
  } = useSteward();
  const [running, setRunning] = useState(false);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [savingSystem, setSavingSystem] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "error"; message: string } | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState(runtimeSettings);
  const [systemDraft, setSystemDraft] = useState(systemSettings);
  const [apiTokenDraft, setApiTokenDraft] = useState("");
  const [webResearchKeyStatus, setWebResearchKeyStatus] = useState<Record<WebResearchProvider, boolean>>({
    brave_scrape: false,
    duckduckgo_scrape: false,
    brave_api: false,
    serper: false,
    serpapi: false,
  });
  const [webResearchKeyDrafts, setWebResearchKeyDrafts] = useState<Record<WebResearchProvider, string>>({
    brave_scrape: "",
    duckduckgo_scrape: "",
    brave_api: "",
    serper: "",
    serpapi: "",
  });
  const [loadingWebResearchKeys, setLoadingWebResearchKeys] = useState(false);
  const [savingWebResearchKeyFor, setSavingWebResearchKeyFor] = useState<WebResearchProvider | null>(null);
  const runtimeSettingsSignature = useMemo(() => settingsSignature(runtimeSettings), [runtimeSettings]);
  const systemSettingsSignature = useMemo(() => settingsSignature(systemSettings), [systemSettings]);
  const persistedRuntimeSettingsSignatureRef = useRef(runtimeSettingsSignature);
  const persistedSystemSettingsSignatureRef = useRef(systemSettingsSignature);

  useEffect(() => {
    const previousSignature = persistedRuntimeSettingsSignatureRef.current;
    if (runtimeSettingsSignature === previousSignature) {
      return;
    }

    persistedRuntimeSettingsSignatureRef.current = runtimeSettingsSignature;
    setRuntimeDraft((current) =>
      settingsSignature(current) === previousSignature ? runtimeSettings : current,
    );
  }, [runtimeSettings, runtimeSettingsSignature]);

  useEffect(() => {
    const previousSignature = persistedSystemSettingsSignatureRef.current;
    if (systemSettingsSignature === previousSignature) {
      return;
    }

    persistedSystemSettingsSignatureRef.current = systemSettingsSignature;
    setSystemDraft((current) =>
      settingsSignature(current) === previousSignature ? systemSettings : current,
    );
  }, [systemSettings, systemSettingsSignature]);

  const loadWebResearchCredentials = useCallback(async () => {
    setLoadingWebResearchKeys(true);
    try {
      const response = await fetch("/api/settings/web-research/credentials", withClientApiToken());
      const data = (await response.json()) as {
        error?: string;
        hasApiKey?: Partial<Record<WebResearchProvider, boolean>>;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to load web research provider keys.");
      }
      setWebResearchKeyStatus((current) => ({
        ...current,
        brave_api: Boolean(data.hasApiKey?.brave_api),
        serper: Boolean(data.hasApiKey?.serper),
        serpapi: Boolean(data.hasApiKey?.serpapi),
      }));
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to load web research provider keys.",
      });
    } finally {
      setLoadingWebResearchKeys(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "web-research") {
      void loadWebResearchCredentials();
    }
  }, [loadWebResearchCredentials, tab]);

  const lastScannerRun = useMemo(() => {
    if (scannerRuns.length === 0) return null;
    const sorted = [...scannerRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return sorted[0];
  }, [scannerRuns]);
  const lastAgentWake = useMemo(() => {
    if (agentRuns.length === 0) return null;
    const sorted = [...agentRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return sorted[0];
  }, [agentRuns]);
  const lastScannerDiscovery = useMemo(
    () => (lastScannerRun ? parseDiscoveryDiagnostics(lastScannerRun.details) : null),
    [lastScannerRun],
  );
  const lastScannerEnrichment = useMemo(
    () => (lastScannerRun ? parseDiscoveryEnrichmentSummary(lastScannerRun.details) : null),
    [lastScannerRun],
  );
  const lastScannerConstrainedPhases = useMemo(
    () => constrainedDiscoveryPhases(lastScannerDiscovery),
    [lastScannerDiscovery],
  );
  const lastScannerDeferredPhases = useMemo(
    () => deferredDiscoveryPhases(lastScannerDiscovery),
    [lastScannerDiscovery],
  );
  const lastScannerSlowestPhase = useMemo(
    () => slowestDiscoveryPhase(lastScannerDiscovery),
    [lastScannerDiscovery],
  );
  const discoveryEnrichmentLanes = useMemo(
    () => controlPlane?.queue.filter((lane) => isDiscoveryEnrichmentLane(lane.kind)) ?? [],
    [controlPlane],
  );
  const otherQueueLanes = useMemo(
    () => controlPlane?.queue.filter((lane) => !isDiscoveryEnrichmentLane(lane.kind)) ?? [],
    [controlPlane],
  );
  const discoveryEnrichmentQueueSummary = useMemo(
    () => summarizeQueueLanes(discoveryEnrichmentLanes),
    [discoveryEnrichmentLanes],
  );
  const lastSuccessfulScannerRun = controlPlane?.lastSuccessfulScannerRun ?? null;
  const lastSuccessfulPeriodicWake = controlPlane?.lastPeriodicAgentWake ?? null;
  const scannerRunning = running || Boolean(lastScannerRun && !lastScannerRun.completedAt);

  const handleRunCycle = useCallback(async () => {
    setRunning(true);
    setFeedback(null);
    try {
      const result = await runAgentCycle();
      const parts = result.summary
        ? Object.entries(result.summary)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")
        : "";
      setFeedback({
        type: "ok",
        message: result.started
          ? "Scanner cycle started. Live updates are streaming."
          : parts
            ? `Scanner cycle complete: ${parts}`
            : "Scanner cycle trigger accepted.",
      });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Scanner cycle failed.",
      });
    } finally {
      setRunning(false);
    }
  }, [runAgentCycle]);

  type RuntimeNumberField = {
    [K in keyof RuntimeSettings]: RuntimeSettings[K] extends number ? K : never;
  }[keyof RuntimeSettings];
  type RuntimeBooleanField = {
    [K in keyof RuntimeSettings]: RuntimeSettings[K] extends boolean ? K : never;
  }[keyof RuntimeSettings];

  const setDraftField = (key: RuntimeNumberField, value: number) => {
    setRuntimeDraft((current) => ({
      ...current,
      [key]: Number.isFinite(value)
        ? Math.max(key === "webResearchDeepReadPages" ? 0 : 1, Math.floor(value))
        : current[key],
    }));
  };

  const setRuntimeToggleField = (key: RuntimeBooleanField, value: boolean) => {
    setRuntimeDraft((current) => ({ ...current, [key]: value }));
  };

  const setWebResearchProvider = (provider: WebResearchProvider) => {
    setRuntimeDraft((current) => ({ ...current, webResearchProvider: provider }));
  };

  const setWebResearchFallbackStrategy = (strategy: RuntimeSettings["webResearchFallbackStrategy"]) => {
    setRuntimeDraft((current) => ({ ...current, webResearchFallbackStrategy: strategy }));
  };

  const setWebResearchKeyDraft = (provider: WebResearchProvider, value: string) => {
    setWebResearchKeyDrafts((current) => ({
      ...current,
      [provider]: value,
    }));
  };

  const saveWebResearchApiKey = useCallback(async (provider: WebResearchProvider) => {
    if (!requiresWebResearchApiKey(provider)) {
      return;
    }

    setSavingWebResearchKeyFor(provider);
    try {
      const trimmed = webResearchKeyDrafts[provider].trim();
      const response = await fetch("/api/settings/web-research/credentials", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: trimmed.length > 0 ? trimmed : null,
        }),
      }));
      const data = (await response.json()) as { error?: string; hasApiKey?: boolean };
      if (!response.ok) {
        throw new Error(data.error ?? `Failed to update API key for ${provider}.`);
      }

      setWebResearchKeyStatus((current) => ({ ...current, [provider]: Boolean(data.hasApiKey) }));
      setWebResearchKeyDrafts((current) => ({ ...current, [provider]: "" }));
      setFeedback({
        type: "ok",
        message: data.hasApiKey
          ? `${WEB_RESEARCH_PROVIDER_META[provider].label} API key saved.`
          : `${WEB_RESEARCH_PROVIDER_META[provider].label} API key cleared.`,
      });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : `Failed to update API key for ${provider}.`,
      });
    } finally {
      setSavingWebResearchKeyFor(null);
    }
  }, [webResearchKeyDrafts]);

  const removeIgnoredIncidentType = (incidentType: string) => {
    setRuntimeDraft((current) => ({
      ...current,
      ignoredIncidentTypes: current.ignoredIncidentTypes.filter((value) => value !== incidentType),
    }));
  };

  const handleSaveRuntime = useCallback(async () => {
    setSavingRuntime(true);
    setFeedback(null);
    try {
      await saveRuntimeSettings(runtimeDraft);
      setFeedback({ type: "ok", message: "Runtime settings saved." });
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save runtime settings." });
    } finally {
      setSavingRuntime(false);
    }
  }, [runtimeDraft, saveRuntimeSettings]);

  const handleSaveSystem = useCallback(async () => {
    setSavingSystem(true);
    setFeedback(null);
    try {
      await saveSystemSettings(systemDraft);
      setFeedback({ type: "ok", message: "System settings saved." });
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save system settings." });
    } finally {
      setSavingSystem(false);
    }
  }, [saveSystemSettings, systemDraft]);

  const handleSetToken = useCallback(async () => {
    setSavingToken(true);
    setFeedback(null);
    try {
      await setApiToken(apiTokenDraft.trim() || null);
      setApiTokenDraft("");
      setFeedback({
        type: "ok",
        message: apiTokenDraft.trim() ? "API auth token updated." : "API auth token cleared.",
      });
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to update API auth token." });
    } finally {
      setSavingToken(false);
    }
  }, [apiTokenDraft, setApiToken]);

  const content = (() => {
    switch (tab) {
      case "agent":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Scanner Status</CardTitle>
              <CardDescription>
                Monitor and trigger the background scanner loop, then tune how often it re-evaluates the network.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border bg-background/50 px-4 py-3">
                {lastScannerRun ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Last Run</p>
                      <Badge
                        variant={!lastScannerRun.completedAt ? "secondary" : lastScannerRun.outcome === "ok" ? "default" : "destructive"}
                        className="text-[10px]"
                      >
                        {!lastScannerRun.completedAt ? "running" : lastScannerRun.outcome}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(lastScannerRun.startedAt).toLocaleString()}
                      </span>
                      <span>({relativeTime(lastScannerRun.startedAt)})</span>
                      {lastScannerRun.completedAt ? (
                        <span>Completed {relativeTime(lastScannerRun.completedAt)}</span>
                      ) : (
                        <span className="font-medium text-foreground">Still running</span>
                      )}
                      </div>
                      {lastScannerRun.summary && (
                        <p className="text-xs text-muted-foreground">{lastScannerRun.summary}</p>
                      )}
                      {lastScannerDiscovery ? (
                        <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="text-[10px]">
                              {lastScannerDiscovery.scanMode}
                            </Badge>
                            <span>Discovery {formatDurationMs(lastScannerDiscovery.elapsedMs)}</span>
                            {lastScannerDiscovery.budgetMs ? (
                              <span>Budget {formatDurationMs(lastScannerDiscovery.budgetMs)}</span>
                            ) : null}
                            {lastScannerConstrainedPhases.length > 0 ? (
                              <Badge variant="secondary" className="text-[10px]">
                                {lastScannerConstrainedPhases.length} constrained
                              </Badge>
                            ) : null}
                            {lastScannerDeferredPhases.length > 0 ? (
                              <Badge variant="outline" className="text-[10px]">
                                {lastScannerDeferredPhases.length} backlog
                              </Badge>
                            ) : null}
                            {lastScannerDiscovery.failedPhaseCount > 0 ? (
                              <Badge variant="destructive" className="text-[10px]">
                                {lastScannerDiscovery.failedPhaseCount} failed
                              </Badge>
                            ) : null}
                          </div>
                          {lastScannerSlowestPhase ? (
                            <p className="text-xs text-muted-foreground">
                              Slowest phase: {lastScannerSlowestPhase.label} ({formatDurationMs(lastScannerSlowestPhase.elapsedMs)})
                            </p>
                          ) : null}
                          <div className="space-y-1">
                            {lastScannerDiscovery.phases.slice(0, 4).map((phase) => (
                              <div key={phase.key} className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                                  <span className="font-medium text-foreground">{phase.label}</span>
                                  <span>{formatDurationMs(phase.elapsedMs)}</span>
                                  {phase.budgetMs ? <span>budget {formatDurationMs(phase.budgetMs)}</span> : null}
                                  {typeof phase.targetCount === "number" ? (
                                    <span>
                                      targets {phase.targetCount}
                                      {typeof phase.dueTargetCount === "number" && phase.dueTargetCount > phase.targetCount
                                        ? `/${phase.dueTargetCount}`
                                        : ""}
                                    </span>
                                  ) : null}
                                  {(phase.deferredTargetCount ?? 0) > 0 ? <span>deferred {phase.deferredTargetCount}</span> : null}
                                </div>
                                <Badge
                                  variant={phase.status === "failed" ? "destructive" : phase.status === "timed_out" ? "secondary" : "outline"}
                                  className="text-[10px]"
                                >
                                  {phaseStatusLabel(phase.status)}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        </div>
                        ) : null}
                        {lastScannerEnrichment && lastScannerEnrichment.phases.length > 0 ? (
                          <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                              <Badge variant="secondary" className="text-[10px]">
                                Background enrichment
                              </Badge>
                              <span>due {lastScannerEnrichment.dueTargets}</span>
                              {lastScannerEnrichment.deferredTargets > 0 ? (
                                <span>deferred {lastScannerEnrichment.deferredTargets}</span>
                              ) : null}
                              {lastScannerEnrichment.phases.filter((phase) => phase.queued).length > 0 ? (
                                <span>
                                  queued {lastScannerEnrichment.phases.filter((phase) => phase.queued).length}
                                </span>
                              ) : null}
                              {lastScannerEnrichment.phases.filter((phase) => phase.queueBusy).length > 0 ? (
                                <span>
                                  {lastScannerEnrichment.phases.filter((phase) => phase.queueBusy).length} already active
                                </span>
                              ) : null}
                            </div>
                            <div className="space-y-1">
                              {lastScannerEnrichment.phases.map((phase) => (
                                <div key={phase.phase} className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                                    <span className="font-medium text-foreground">
                                      {discoveryEnrichmentPhaseLabel(phase.phase)}
                                    </span>
                                    <span>wave {phase.targetCount}</span>
                                    <span>due {phase.dueTargetCount}</span>
                                    {phase.deferredTargetCount > 0 ? (
                                      <span>deferred {phase.deferredTargetCount}</span>
                                    ) : null}
                                  </div>
                                  <Badge
                                    variant={phase.queued ? "default" : phase.queueBusy ? "secondary" : "outline"}
                                    className="text-[10px]"
                                  >
                                    {phase.queued ? "queued" : phase.queueBusy ? "already active" : "planned"}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {lastSuccessfulScannerRun && lastSuccessfulScannerRun.id !== lastScannerRun.id ? (
                          <p className="text-xs text-muted-foreground">
                            Last successful completion: {new Date(lastSuccessfulScannerRun.completedAt ?? lastSuccessfulScannerRun.startedAt).toLocaleString()}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No scanner runs recorded yet.
                  </p>
                )}
              </div>

              <div className="rounded-lg border bg-background/50 px-4 py-3">
                {lastAgentWake ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Last Agent Wake</p>
                      <Badge
                        variant={!lastAgentWake.completedAt ? "secondary" : lastAgentWake.outcome === "ok" ? "default" : "destructive"}
                        className="text-[10px]"
                      >
                        {!lastAgentWake.completedAt ? "running" : lastAgentWake.outcome}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(lastAgentWake.startedAt).toLocaleString()}
                      </span>
                      <span>({relativeTime(lastAgentWake.startedAt)})</span>
                      {lastAgentWake.completedAt ? (
                        <span>Completed {relativeTime(lastAgentWake.completedAt)}</span>
                      ) : (
                        <span className="font-medium text-foreground">Still running</span>
                      )}
                      </div>
                      {lastAgentWake.summary && (
                        <p className="text-xs text-muted-foreground">{lastAgentWake.summary}</p>
                      )}
                      {lastSuccessfulPeriodicWake ? (
                        <p className="text-xs text-muted-foreground">
                          Last periodic review: {new Date(lastSuccessfulPeriodicWake.completedAt ?? lastSuccessfulPeriodicWake.startedAt).toLocaleString()}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No agent wakes recorded yet.
                  </p>
                )}
              </div>

              <Button onClick={() => void handleRunCycle()} disabled={scannerRunning}>
                {scannerRunning ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Running scanner...
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-4 w-4" />
                    Run Scanner Cycle
                  </>
                )}
              </Button>

              <div className="grid gap-3 md:grid-cols-2">
                <SettingsNumberField
                  label="Scanner interval (ms)"
                  value={runtimeDraft.scannerIntervalMs}
                  onChange={(value) => setDraftField("scannerIntervalMs", value)}
                />
                <SettingsNumberField
                  label="Agent wake interval (ms)"
                  value={runtimeDraft.agentWakeIntervalMs}
                  onChange={(value) => setDraftField("agentWakeIntervalMs", value)}
                />
              </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>
                    Scanner every <strong className="text-foreground">{Math.round(runtimeDraft.scannerIntervalMs / 1000)}s</strong>
                    {" "}and agent review every{" "}
                    <strong className="text-foreground">{Math.round(runtimeDraft.agentWakeIntervalMs / 1000)}s</strong>
                  </span>
                </div>

                <div className="rounded-lg border bg-background/50 px-4 py-3">
                  {controlPlane ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">Control Plane Health</p>
                          <p className="text-xs text-muted-foreground">
                            Queue lag, worker leases, and last successful runtime milestones.
                          </p>
                        </div>
                        <Badge variant={controlPlane.summary.longRunningProcessing > 0 ? "destructive" : controlPlane.summary.processing > 0 ? "secondary" : "outline"} className="text-[10px]">
                          {controlPlane.summary.longRunningProcessing > 0
                            ? `${controlPlane.summary.longRunningProcessing} long-running job(s)`
                            : controlPlane.summary.processing > 0
                              ? `${controlPlane.summary.processing} job(s) active`
                              : "idle"}
                        </Badge>
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border bg-card/40 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending</p>
                          <p className="mt-1 text-lg font-semibold">{controlPlane.summary.pending}</p>
                        </div>
                        <div className="rounded-md border bg-card/40 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Processing</p>
                          <p className="mt-1 text-lg font-semibold">{controlPlane.summary.processing}</p>
                        </div>
                        <div className="rounded-md border bg-card/40 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Long-running</p>
                          <p className="mt-1 text-lg font-semibold">{controlPlane.summary.longRunningProcessing}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {controlPlane.leases.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No runtime leases recorded yet.</p>
                        ) : (
                          controlPlane.leases.map((lease) => (
                            <div key={lease.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card/40 px-3 py-2 text-xs">
                              <div className="space-y-0.5">
                                <p className="font-medium text-foreground">{lease.name}</p>
                                <p className="text-muted-foreground">{lease.holder}</p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                                <Badge variant="outline" className="text-[10px]">
                                  lease
                                </Badge>
                                <span>Updated {relativeTime(lease.updatedAt)}</span>
                                <span>Expires {new Date(lease.expiresAt).toLocaleTimeString()}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>

                      <div className="space-y-2">
                        <div>
                          <p className="text-xs font-medium text-foreground">Background discovery enrichment</p>
                          <p className="text-xs text-muted-foreground">
                            Deep fingerprinting, browser observation, and hostname waves now run outside the core scanner loop.
                          </p>
                        </div>
                        {discoveryEnrichmentLanes.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No discovery enrichment workers have queued work yet.</p>
                        ) : (
                          <>
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="rounded-md border bg-card/40 px-3 py-2">
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending</p>
                                <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.pending}</p>
                              </div>
                              <div className="rounded-md border bg-card/40 px-3 py-2">
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Processing</p>
                                <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.processing}</p>
                              </div>
                              <div className="rounded-md border bg-card/40 px-3 py-2">
                                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Completed</p>
                                <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.completed}</p>
                              </div>
                            </div>
                            {discoveryEnrichmentLanes.map((lane) => (
                              <div key={lane.kind} className="rounded-md border bg-card/40 px-3 py-2 text-xs">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="space-y-0.5">
                                    <p className="font-medium text-foreground">{queueLaneLabel(lane.kind)}</p>
                                    <p className="text-muted-foreground">{lane.kind}</p>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                                    <span>pending {lane.pending}</span>
                                    <span>processing {lane.processing}</span>
                                    <span>completed {lane.completed}</span>
                                  </div>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-3 text-muted-foreground">
                                  {lane.oldestPendingRunAfter ? <span>Oldest due {relativeTime(lane.oldestPendingRunAfter)}</span> : null}
                                  {lane.oldestProcessingUpdatedAt ? <span>Oldest processing update {relativeTime(lane.oldestProcessingUpdatedAt)}</span> : null}
                                  {lane.newestUpdatedAt ? <span>Latest update {relativeTime(lane.newestUpdatedAt)}</span> : null}
                                </div>
                              </div>
                            ))}
                          </>
                        )}
                      </div>

                      <div className="space-y-2">
                        <div>
                          <p className="text-xs font-medium text-foreground">Other queue lanes</p>
                          <p className="text-xs text-muted-foreground">Core scanner, monitor, and agent control-plane work.</p>
                        </div>
                        {otherQueueLanes.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No queued control-plane jobs recorded yet.</p>
                        ) : (
                          otherQueueLanes.map((lane) => (
                            <div key={lane.kind} className="rounded-md border bg-card/40 px-3 py-2 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="space-y-0.5">
                                  <p className="font-medium text-foreground">{queueLaneLabel(lane.kind)}</p>
                                  <p className="text-muted-foreground">{lane.kind}</p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                                  <span>pending {lane.pending}</span>
                                  <span>processing {lane.processing}</span>
                                  <span>completed {lane.completed}</span>
                                </div>
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-3 text-muted-foreground">
                                {lane.oldestPendingRunAfter ? <span>Oldest due {relativeTime(lane.oldestPendingRunAfter)}</span> : null}
                                {lane.oldestProcessingUpdatedAt ? <span>Oldest processing update {relativeTime(lane.oldestProcessingUpdatedAt)}</span> : null}
                                {lane.newestUpdatedAt ? <span>Latest update {relativeTime(lane.newestUpdatedAt)}</span> : null}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Control-plane health has not loaded yet.
                    </p>
                  )}
                </div>

                <RuntimeSaveButton
                  saving={savingRuntime}
                  label="Save Control Plane Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "discovery":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Discovery Scope</CardTitle>
              <CardDescription>
                Tune scan cadence, target budgets, and the core discovery protocols Steward uses on the network.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <SettingsNumberField
                  label="Deep scan interval (ms)"
                  value={runtimeDraft.deepScanIntervalMs}
                  onChange={(value) => setDraftField("deepScanIntervalMs", value)}
                />
                <SettingsNumberField
                  label="Incremental active targets"
                  value={runtimeDraft.incrementalActiveTargets}
                  onChange={(value) => setDraftField("incrementalActiveTargets", value)}
                />
                <SettingsNumberField
                  label="Deep active targets"
                  value={runtimeDraft.deepActiveTargets}
                  onChange={(value) => setDraftField("deepActiveTargets", value)}
                />
                <SettingsNumberField
                  label="Incremental port-scan hosts"
                  value={runtimeDraft.incrementalPortScanHosts}
                  onChange={(value) => setDraftField("incrementalPortScanHosts", value)}
                />
                <SettingsNumberField
                  label="Deep port-scan hosts"
                  value={runtimeDraft.deepPortScanHosts}
                  onChange={(value) => setDraftField("deepPortScanHosts", value)}
                />
                <SettingsNumberField
                  label="LLM discovery advice batch size"
                  value={runtimeDraft.llmDiscoveryLimit}
                  onChange={(value) => setDraftField("llmDiscoveryLimit", value)}
                />
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                <SettingsToggleRow
                  label="Enable mDNS discovery"
                  checked={runtimeDraft.enableMdnsDiscovery}
                  onChange={(checked) => setRuntimeToggleField("enableMdnsDiscovery", checked)}
                />
                <SettingsToggleRow
                  label="Enable SSDP discovery"
                  checked={runtimeDraft.enableSsdpDiscovery}
                  onChange={(checked) => setRuntimeToggleField("enableSsdpDiscovery", checked)}
                />
                <SettingsToggleRow
                  label="Enable SNMP probe"
                  checked={runtimeDraft.enableSnmpProbe}
                  onChange={(checked) => setRuntimeToggleField("enableSnmpProbe", checked)}
                />
              </div>

              <RuntimeSaveButton
                saving={savingRuntime}
                label="Save Discovery Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "fingerprinting":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Fingerprinting &amp; Enrichment</CardTitle>
              <CardDescription>
                Control how aggressively Steward fingerprints hosts and refreshes vendor-level metadata.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <SettingsNumberField
                  label="Incremental fingerprint targets"
                  value={runtimeDraft.incrementalFingerprintTargets}
                  onChange={(value) => setDraftField("incrementalFingerprintTargets", value)}
                />
                <SettingsNumberField
                  label="Deep fingerprint targets"
                  value={runtimeDraft.deepFingerprintTargets}
                  onChange={(value) => setDraftField("deepFingerprintTargets", value)}
                />
                <SettingsNumberField
                  label="Incremental nmap targets"
                  value={runtimeDraft.incrementalNmapTargets}
                  onChange={(value) => setDraftField("incrementalNmapTargets", value)}
                />
                <SettingsNumberField
                  label="Deep nmap targets"
                  value={runtimeDraft.deepNmapTargets}
                  onChange={(value) => setDraftField("deepNmapTargets", value)}
                />
                <SettingsNumberField
                  label="Nmap timeout (ms)"
                  value={runtimeDraft.nmapFingerprintTimeoutMs}
                  onChange={(value) => setDraftField("nmapFingerprintTimeoutMs", value)}
                />
                <SettingsNumberField
                  label="OUI update interval (ms)"
                  value={runtimeDraft.ouiUpdateIntervalMs}
                  onChange={(value) => setDraftField("ouiUpdateIntervalMs", value)}
                />
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                <SettingsToggleRow
                  label="Enable advanced nmap fingerprinting"
                  checked={runtimeDraft.enableAdvancedNmapFingerprint}
                  onChange={(checked) => setRuntimeToggleField("enableAdvancedNmapFingerprint", checked)}
                />
              </div>

              <RuntimeSaveButton
                saving={savingRuntime}
                label="Save Fingerprinting Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "observation":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Observation &amp; Host Intel</CardTitle>
              <CardDescription>
                Configure packet capture, browser inspection, and local host metadata collection.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <SettingsNumberField
                  label="Packet intel duration (sec)"
                  value={runtimeDraft.packetIntelDurationSec}
                  onChange={(value) => setDraftField("packetIntelDurationSec", value)}
                />
                <SettingsNumberField
                  label="Packet intel max packets"
                  value={runtimeDraft.packetIntelMaxPackets}
                  onChange={(value) => setDraftField("packetIntelMaxPackets", value)}
                />
                <SettingsNumberField
                  label="Packet intel top talkers"
                  value={runtimeDraft.packetIntelTopTalkers}
                  onChange={(value) => setDraftField("packetIntelTopTalkers", value)}
                />
                <SettingsNumberField
                  label="Browser observation timeout (ms)"
                  value={runtimeDraft.browserObservationTimeoutMs}
                  onChange={(value) => setDraftField("browserObservationTimeoutMs", value)}
                />
                <SettingsNumberField
                  label="Incremental browser targets"
                  value={runtimeDraft.incrementalBrowserObservationTargets}
                  onChange={(value) => setDraftField("incrementalBrowserObservationTargets", value)}
                />
                <SettingsNumberField
                  label="Deep browser targets"
                  value={runtimeDraft.deepBrowserObservationTargets}
                  onChange={(value) => setDraftField("deepBrowserObservationTargets", value)}
                />
                <SettingsNumberField
                  label="DHCP lease command timeout (ms)"
                  value={runtimeDraft.dhcpLeaseCommandTimeoutMs}
                  onChange={(value) => setDraftField("dhcpLeaseCommandTimeoutMs", value)}
                  className="md:col-span-2"
                />
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                <SettingsToggleRow
                  label="Enable packet intelligence (tshark)"
                  checked={runtimeDraft.enablePacketIntel}
                  onChange={(checked) => setRuntimeToggleField("enablePacketIntel", checked)}
                />
                <SettingsToggleRow
                  label="Enable browser observation (Playwright)"
                  checked={runtimeDraft.enableBrowserObservation}
                  onChange={(checked) => setRuntimeToggleField("enableBrowserObservation", checked)}
                />
                <SettingsToggleRow
                  label="Capture browser screenshots"
                  checked={runtimeDraft.browserObservationCaptureScreenshots}
                  onChange={(checked) => setRuntimeToggleField("browserObservationCaptureScreenshots", checked)}
                />
                <SettingsToggleRow
                  label="Enable DHCP lease intelligence"
                  checked={runtimeDraft.enableDhcpLeaseIntel}
                  onChange={(checked) => setRuntimeToggleField("enableDhcpLeaseIntel", checked)}
                />
              </div>

              <RuntimeSaveButton
                saving={savingRuntime}
                label="Save Observation Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "web-research":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Discovery Web Research</CardTitle>
              <CardDescription>
                Manage public-web enrichment provider settings and the vault-backed API keys they need.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Web research provider</Label>
                  <Select
                    value={runtimeDraft.webResearchProvider}
                    onValueChange={(value) => setWebResearchProvider(value as WebResearchProvider)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEB_RESEARCH_PROVIDER_ORDER.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {WEB_RESEARCH_PROVIDER_META[provider].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Web research fallback strategy</Label>
                  <Select
                    value={runtimeDraft.webResearchFallbackStrategy}
                    onValueChange={(value) =>
                      setWebResearchFallbackStrategy(value as RuntimeSettings["webResearchFallbackStrategy"])}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {webResearchFallbackStrategyOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <SettingsNumberField
                  label="Web research timeout (ms)"
                  value={runtimeDraft.webResearchTimeoutMs}
                  onChange={(value) => setDraftField("webResearchTimeoutMs", value)}
                />
                <SettingsNumberField
                  label="Web research max results"
                  value={runtimeDraft.webResearchMaxResults}
                  onChange={(value) => setDraftField("webResearchMaxResults", value)}
                />
                <SettingsNumberField
                  label="Web research deep-read pages"
                  value={runtimeDraft.webResearchDeepReadPages}
                  onChange={(value) => setDraftField("webResearchDeepReadPages", value)}
                  className="md:col-span-2"
                />
              </div>

              {runtimeDraft.webResearchFallbackStrategy === "selected_only" && (
                <Alert>
                  <AlertDescription>
                    Selected-only fallback means Steward will not retry another provider if the chosen search engine returns zero results.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                <SettingsToggleRow
                  label="Enable public web research"
                  checked={runtimeDraft.enableWebResearch}
                  onChange={(checked) => setRuntimeToggleField("enableWebResearch", checked)}
                />
                <p className="text-xs text-muted-foreground">
                  Provider API keys are stored in the vault and never in runtime settings.
                </p>
              </div>

              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                {WEB_RESEARCH_PROVIDER_ORDER.filter((provider) => requiresWebResearchApiKey(provider)).map((provider) => (
                  <div key={provider} className="rounded-md border border-border/50 bg-background/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{WEB_RESEARCH_PROVIDER_META[provider].label}</p>
                        <p className="text-xs text-muted-foreground">{WEB_RESEARCH_PROVIDER_META[provider].description}</p>
                      </div>
                      <Badge variant={webResearchKeyStatus[provider] ? "default" : "outline"} className="text-[10px]">
                        {webResearchKeyStatus[provider] ? "API key set" : "No key"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[220px] flex-1 space-y-1">
                        <Label className="text-xs text-muted-foreground">API key</Label>
                        <Input
                          type="password"
                          value={webResearchKeyDrafts[provider]}
                          placeholder="Enter new key or leave blank to clear"
                          onChange={(e) => setWebResearchKeyDraft(provider, e.target.value)}
                        />
                      </div>
                      <Button
                        variant="outline"
                        disabled={loadingWebResearchKeys || savingWebResearchKeyFor === provider}
                        onClick={() => void saveWebResearchApiKey(provider)}
                      >
                        {savingWebResearchKeyFor === provider ? (
                          <>
                            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : "Save key"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <RuntimeSaveButton
                saving={savingRuntime}
                label="Save Research Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "alerts":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">Incident Alert Scanners</CardTitle>
              <CardDescription>
                Configure which built-in scanners can raise incidents and manage ignored incident types.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
                <SettingsToggleRow
                  label="Availability scanner alerts (offline devices)"
                  checked={runtimeDraft.availabilityScannerAlertsEnabled}
                  onChange={(checked) => setRuntimeToggleField("availabilityScannerAlertsEnabled", checked)}
                />
                <SettingsToggleRow
                  label="Security scanner alerts (Telnet exposure)"
                  checked={runtimeDraft.securityScannerAlertsEnabled}
                  onChange={(checked) => setRuntimeToggleField("securityScannerAlertsEnabled", checked)}
                />
                <SettingsToggleRow
                  label="Assurance scanner alerts (workload drift and monitor failures)"
                  checked={runtimeDraft.serviceContractScannerAlertsEnabled}
                  onChange={(checked) => setRuntimeToggleField("serviceContractScannerAlertsEnabled", checked)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Ignored incident types</Label>
                {runtimeDraft.ignoredIncidentTypes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No incident types are currently ignored.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {runtimeDraft.ignoredIncidentTypes.map((incidentType) => (
                      <div
                        key={incidentType}
                        className="flex items-center gap-2 rounded-md border bg-background/50 px-2.5 py-1.5"
                      >
                        <Badge variant="outline" className="text-[10px]">
                          {formatIncidentType(incidentType)}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => removeIgnoredIncidentType(incidentType)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <RuntimeSaveButton
                saving={savingRuntime}
                label="Save Alert Settings"
                onClick={() => void handleSaveRuntime()}
              />
            </CardContent>
          </Card>
        );
      case "system":
        return (
          <Card className="bg-card/60">
            <CardHeader>
              <CardTitle className="text-base">System and Security</CardTitle>
              <CardDescription>
                DB-backed system defaults, scheduled digest window, API token guard, and access control shortcuts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  RBAC users/sessions, OIDC SSO, and LDAP login settings are managed in Access Controls.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    window.location.assign("/access");
                  }}
                >
                  Open Access Controls
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Node identity</Label>
                  <Input
                    value={systemDraft.nodeIdentity}
                    onChange={(e) => setSystemDraft((current) => ({ ...current, nodeIdentity: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Timezone (IANA)</Label>
                  <Input
                    value={systemDraft.timezone}
                    onChange={(e) => setSystemDraft((current) => ({ ...current, timezone: e.target.value }))}
                    placeholder="America/Toronto"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Upgrade channel</Label>
                  <Select
                    value={systemDraft.upgradeChannel}
                    onValueChange={(value) =>
                      setSystemDraft((current) => ({ ...current, upgradeChannel: value as "stable" | "preview" }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stable">Stable</SelectItem>
                      <SelectItem value="preview">Preview</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Daily digest schedule</Label>
                  <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={systemDraft.digestScheduleEnabled}
                        onChange={(e) =>
                          setSystemDraft((current) => ({ ...current, digestScheduleEnabled: e.target.checked }))
                        }
                      />
                      Enabled
                    </label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      className="h-8 w-20"
                      value={systemDraft.digestHourLocal}
                      onChange={(e) =>
                        setSystemDraft((current) => ({
                          ...current,
                          digestHourLocal: Math.max(0, Math.min(23, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">:</span>
                    <Input
                      type="number"
                      min={0}
                      max={59}
                      className="h-8 w-20"
                      value={systemDraft.digestMinuteLocal}
                      onChange={(e) =>
                        setSystemDraft((current) => ({
                          ...current,
                          digestMinuteLocal: Math.max(0, Math.min(59, Number(e.target.value) || 0)),
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
              <Button onClick={() => void handleSaveSystem()} disabled={savingSystem}>
                {savingSystem ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Settings2 className="mr-1.5 h-4 w-4" />}
                {savingSystem ? "Saving..." : "Save System Settings"}
              </Button>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-muted-foreground">API auth token</Label>
                  <Badge variant={authSettings.apiTokenEnabled ? "default" : "secondary"} className="text-[10px]">
                    {authSettings.apiTokenEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    placeholder="Enter new token (min 16 chars)"
                    value={apiTokenDraft}
                    onChange={(e) => setApiTokenDraft(e.target.value)}
                  />
                  <Button onClick={() => void handleSetToken()} disabled={savingToken}>
                    {savingToken ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    {savingToken ? "Saving..." : "Set / Clear"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Token values are never returned by the API. Send it as `Authorization: Bearer &lt;token&gt;` or `x-steward-token`.
                </p>
              </div>
            </CardContent>
          </Card>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-4">
      {feedback && (
        <Alert variant={feedback.type === "error" ? "destructive" : "default"}>
          <AlertDescription className="text-xs">{feedback.message}</AlertDescription>
        </Alert>
      )}

      {content}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { loading } = useSteward();
  const [activeTab, setActiveTab] = useState<SettingsTabValue>("providers");

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure providers, vault, and agent behavior.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SettingsTabValue)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
          <TabsTrigger value="discovery">Discovery</TabsTrigger>
          <TabsTrigger value="fingerprinting">Fingerprinting</TabsTrigger>
          <TabsTrigger value="observation">Observation</TabsTrigger>
          <TabsTrigger value="web-research">Web Research</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <div className="mt-4 min-h-0 flex-1 overflow-auto">
          {activeTab === "providers" && <ProvidersSection />}
          {activeTab === "vault" && <VaultSection />}
          {isGeneralTabValue(activeTab) && <GeneralSection tab={activeTab} />}
        </div>
      </Tabs>
    </div>
  );
}
