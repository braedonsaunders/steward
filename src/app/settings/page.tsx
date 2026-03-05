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
import { PROVIDER_REGISTRY, type ProviderMeta } from "@/lib/llm/registry";
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
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { LLMProvider } from "@/lib/state/types";
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

function GeneralSection() {
  const {
    agentRuns,
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

  useEffect(() => {
    setRuntimeDraft(runtimeSettings);
  }, [runtimeSettings]);

  useEffect(() => {
    setSystemDraft(systemSettings);
  }, [systemSettings]);

  const lastRun = useMemo(() => {
    if (agentRuns.length === 0) return null;
    const sorted = [...agentRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    return sorted[0];
  }, [agentRuns]);

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
          ? "Cycle started. Live updates are streaming."
          : parts
            ? `Cycle complete: ${parts}`
            : "Cycle trigger accepted.",
      });
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Agent cycle failed.",
      });
    } finally {
      setRunning(false);
    }
  }, [runAgentCycle]);

  const setDraftField = <K extends keyof typeof runtimeDraft>(key: K, value: number) => {
    setRuntimeDraft((current) => ({ ...current, [key]: Number.isFinite(value) ? Math.max(1, Math.floor(value)) : current[key] }));
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

  return (
    <div className="space-y-4">
      <Card className="bg-card/60">
        <CardHeader>
          <CardTitle className="text-base">Agent Status</CardTitle>
          <CardDescription>
            Monitor and trigger the autonomous agent loop.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-background/50 px-4 py-3">
            {lastRun ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Last Run</p>
                  <Badge
                    variant={lastRun.outcome === "ok" ? "default" : "destructive"}
                    className="text-[10px]"
                  >
                    {lastRun.outcome}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(lastRun.startedAt).toLocaleString()}
                  </span>
                  <span>({relativeTime(lastRun.startedAt)})</span>
                </div>
                {lastRun.summary && (
                  <p className="text-xs text-muted-foreground">{lastRun.summary}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No agent runs recorded yet.
              </p>
            )}
          </div>

          <Button onClick={() => void handleRunCycle()} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Running cycle...
              </>
            ) : (
              <>
                <Play className="mr-1.5 h-4 w-4" />
                Run Agent Cycle
              </>
            )}
          </Button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
            <span>
              Configured loop interval: <strong className="text-foreground">{Math.round(runtimeSettings.agentIntervalMs / 1000)}s</strong>
            </span>
          </div>

          {feedback && (
            <Alert variant={feedback.type === "error" ? "destructive" : "default"}>
              <AlertDescription className="text-xs">{feedback.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card/60">
        <CardHeader>
          <CardTitle className="text-base">Discovery Runtime Tuning</CardTitle>
          <CardDescription>
            Persisted in SQLite and applied by the discovery loop.
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
              <Label className="text-xs text-muted-foreground">Agent interval (ms)</Label>
              <Input type="number" value={runtimeDraft.agentIntervalMs} onChange={(e) => setDraftField("agentIntervalMs", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Deep scan interval (ms)</Label>
              <Input type="number" value={runtimeDraft.deepScanIntervalMs} onChange={(e) => setDraftField("deepScanIntervalMs", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Incremental active targets</Label>
              <Input type="number" value={runtimeDraft.incrementalActiveTargets} onChange={(e) => setDraftField("incrementalActiveTargets", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Deep active targets</Label>
              <Input type="number" value={runtimeDraft.deepActiveTargets} onChange={(e) => setDraftField("deepActiveTargets", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Incremental port-scan hosts</Label>
              <Input type="number" value={runtimeDraft.incrementalPortScanHosts} onChange={(e) => setDraftField("incrementalPortScanHosts", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Deep port-scan hosts</Label>
              <Input type="number" value={runtimeDraft.deepPortScanHosts} onChange={(e) => setDraftField("deepPortScanHosts", Number(e.target.value))} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs text-muted-foreground">LLM discovery advice batch size</Label>
              <Input type="number" value={runtimeDraft.llmDiscoveryLimit} onChange={(e) => setDraftField("llmDiscoveryLimit", Number(e.target.value))} />
            </div>
          </div>
          <Button onClick={() => void handleSaveRuntime()} disabled={savingRuntime}>
            {savingRuntime ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Settings2 className="mr-1.5 h-4 w-4" />}
            {savingRuntime ? "Saving..." : "Save Discovery Settings"}
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card/60">
        <CardHeader>
          <CardTitle className="text-base">System and Security</CardTitle>
          <CardDescription>
            DB-backed system defaults, scheduled digest window, and API token guard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { loading } = useSteward();

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

      <Tabs defaultValue="providers" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="mt-4 min-h-0 flex-1 overflow-auto">
          <ProvidersSection />
        </TabsContent>

        <TabsContent value="vault" className="mt-4 min-h-0 flex-1 overflow-auto">
          <VaultSection />
        </TabsContent>

        <TabsContent value="general" className="mt-4 min-h-0 flex-1 overflow-auto">
          <GeneralSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
