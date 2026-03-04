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
  Key,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Settings2,
  Shield,
  ShieldCheck,
  ShieldOff,
  Unlock,
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
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { LLMProvider } from "@/lib/state/types";
import { cn } from "@/lib/utils";

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
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [status, setStatus] = useState<"idle" | "waiting" | "complete" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

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
      const res = await fetch("/api/providers/oauth/openai/start", { method: "POST" });
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
          const statusRes = await fetch("/api/providers/oauth/openai/status");
          const statusData = (await statusRes.json()) as {
            status: "pending" | "complete" | "error";
            error?: string;
          };

          if (statusData.status === "complete") {
            setStatus("complete");
            stopPolling();
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
  }, [disabled, disabledReason, stopPolling]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
        <div>
          <p className="text-sm font-medium">OAuth (ChatGPT Plus)</p>
          <p className="text-xs text-muted-foreground">
            Sign in with your OpenAI account
          </p>
        </div>
        {status === "waiting" ? (
          <Button variant="outline" size="sm" disabled>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Waiting...
          </Button>
        ) : status === "complete" ? (
          <Badge variant="default" className="text-xs">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Connected
          </Badge>
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
      {status === "error" && error && (
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
}: {
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "waiting" | "exchanging" | "complete" | "error">("idle");
  const [pastedCode, setPastedCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startFlow = useCallback(async () => {
    if (disabled) {
      setPhase("error");
      setError(disabledReason ?? "Vault must be initialized and unlocked first.");
      return;
    }

    setPhase("waiting");
    setError(null);

    try {
      const res = await fetch("/api/providers/oauth/anthropic/start", { method: "POST" });
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
      const res = await fetch("/api/providers/oauth/anthropic/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pastedCode.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setPhase("error");
        setError(typeof data.error === "string" ? data.error : "Code exchange failed");
        return;
      }

      setPhase("complete");
      setPastedCode("");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Code exchange failed");
    }
  }, [disabled, disabledReason, pastedCode]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
        <div>
          <p className="text-sm font-medium">OAuth (Claude Account)</p>
          <p className="text-xs text-muted-foreground">
            Create an API key via your Anthropic account
          </p>
        </div>
        {phase === "complete" ? (
          <Badge variant="default" className="text-xs">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Key Created
          </Badge>
        ) : phase !== "waiting" && phase !== "exchanging" ? (
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

      {(phase === "waiting" || phase === "exchanging") && (
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
              disabled={disabled || !pastedCode.trim() || phase === "exchanging"}
              title={disabled ? disabledReason : undefined}
            >
              {phase === "exchanging" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Submit"
              )}
            </Button>
          </div>
        </div>
      )}

      {phase === "error" && error && (
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
}: {
  provider: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background/50 px-4 py-3">
      <div>
        <p className="text-sm font-medium">OAuth</p>
        <p className="text-xs text-muted-foreground">
          Connect via {label} OAuth flow
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => {
          window.open(
            `/api/providers/oauth/start?provider=${provider}`,
            "_blank",
            "noopener,noreferrer",
          );
        }}
      >
        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
        Connect
      </Button>
    </div>
  );
}

function ProvidersSection() {
  const { providerConfigs, saveProvider, vaultStatus } = useSteward();
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
  const [customModel, setCustomModel] = useState(false);
  const didInitializeSelection = useRef(false);

  const vaultReady = Boolean(vaultStatus?.initialized && vaultStatus?.unlocked);
  const vaultSetupMessage = !vaultStatus?.initialized
    ? "Initialize the vault in the Vault tab before configuring providers."
    : "Unlock the vault in the Vault tab before configuring providers.";

  // Handle OAuth callback query params
  const oauthStatus = searchParams.get("oauth");
  const oauthProvider = searchParams.get("provider") as LLMProvider | null;
  const oauthReason = searchParams.get("reason");

  // Auto-select the provider that just completed OAuth
  useEffect(() => {
    if (oauthProvider) {
      setSelectedId(oauthProvider);
      didInitializeSelection.current = true;
    }
  }, [oauthProvider]);

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
      setModelsLoading(true);
      const url = `/api/providers/models?provider=${provider}${refresh ? "&refresh=1" : ""}`;
      fetch(url)
        .then((res) => res.json())
        .then((data: { models?: string[] }) => {
          setAvailableModels(data.models ?? []);
          setModelsLoading(false);
        })
        .catch(() => {
          setAvailableModels([]);
          setModelsLoading(false);
        });
    },
    [],
  );

  // Fetch models when provider changes
  useEffect(() => {
    setAvailableModels([]);
    setCustomModel(false);
    fetchModels(selectedId);
  }, [selectedId, fetchModels]);

  // Sync draft when provider selection or config changes
  useEffect(() => {
    const meta = PROVIDER_REGISTRY.find((p) => p.id === selectedId);
    setDraft({
      enabled: selectedConfig?.enabled ?? true,
      model: selectedConfig?.model ?? meta?.defaultModel ?? "",
      apiKey: "",
      baseUrl: selectedConfig?.baseUrl ?? meta?.defaultBaseUrl ?? "",
    });
    setFeedback(null);
  }, [selectedId, selectedConfig]);

  const handleSave = useCallback(async () => {
    if (!vaultReady) {
      setFeedback({ type: "error", message: vaultSetupMessage });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      await saveProvider(selectedId, {
        enabled: draft.enabled,
        model: draft.model,
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
  }, [selectedId, draft, saveProvider, vaultReady, vaultSetupMessage]);

  const showBaseUrl = selectedMeta?.openaiCompatible || selectedMeta?.category === "local";
  const showApiKey = selectedMeta?.requiresApiKey !== false;
  const showOAuth = selectedMeta?.supportsOAuth === true;

  return (
    <div className="space-y-6">
      {!vaultReady && (
        <Alert variant="destructive">
          <ShieldOff className="h-4 w-4" />
          <AlertDescription className="text-sm">
            {vaultSetupMessage}
          </AlertDescription>
        </Alert>
      )}

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

          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Active Provider</p>
              <p className="text-xs text-muted-foreground">
                Exactly one provider is active at a time. Enabling this provider disables all others on save.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) =>
                setDraft((prev) => ({ ...prev, enabled: checked }))
              }
              disabled={!vaultReady}
            />
          </div>

          <Separator />

          {/* Model */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="provider-model" className="text-xs text-muted-foreground">
                Model
              </Label>
              <div className="flex items-center gap-2">
                {availableModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCustomModel((v) => !v)}
                    disabled={!vaultReady}
                    className="text-[10px] text-primary hover:underline"
                  >
                    {customModel ? "Show list" : "Custom"}
                  </button>
                )}
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
            {customModel ? (
              <Input
                id="provider-model"
                value={draft.model}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, model: e.target.value }))
                }
                disabled={!vaultReady}
                placeholder={selectedMeta?.defaultModel || "e.g. gpt-4o"}
              />
            ) : (
              <Select
                value={draft.model || undefined}
                disabled={!vaultReady}
                onValueChange={(v) => {
                  if (v === "__custom__") {
                    setCustomModel(true);
                  } else {
                    setDraft((prev) => ({ ...prev, model: v }));
                  }
                }}
              >
                <SelectTrigger id="provider-model" className="w-full">
                  {modelsLoading ? (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    <SelectValue placeholder={draft.model || "Select a model"} />
                  )}
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                  {/* Always include current model if not in list */}
                  {draft.model && !availableModels.includes(draft.model) && (
                    <SelectItem value={draft.model}>
                      {draft.model}
                    </SelectItem>
                  )}
                  <SelectItem value="__custom__">
                    <span className="text-muted-foreground">Enter custom model ID...</span>
                  </SelectItem>
                </SelectContent>
              </Select>
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
                    {selectedConfig?.apiKeyEnvVar && (
                      <p className="text-[10px] text-muted-foreground">
                        Also reads from env:{" "}
                        <code className="font-mono">
                          {selectedConfig.apiKeyEnvVar}
                        </code>
                      </p>
                    )}
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
                        disabled={!vaultReady}
                        disabledReason={vaultSetupMessage}
                      />
                    )}
                    {selectedMeta?.oauthMethod === "code-paste" && (
                      <AnthropicOAuthSection
                        disabled={!vaultReady}
                        disabledReason={vaultSetupMessage}
                      />
                    )}
                    {(selectedMeta?.oauthMethod === "redirect" || selectedMeta?.oauthMethod === "openrouter") && (
                      <RedirectOAuthSection
                        provider={selectedId}
                        label={selectedMeta.label}
                        disabled={!vaultReady}
                        disabledReason={vaultSetupMessage}
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
              disabled={saving || !vaultReady}
              title={!vaultReady ? vaultSetupMessage : undefined}
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
  const { vaultStatus, vaultAction } = useSteward();
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "error"; message: string } | null>(null);

  const handleVaultAction = useCallback(
    async (action: "init" | "unlock" | "lock") => {
      setBusy(true);
      setFeedback(null);
      try {
        await vaultAction(action, action === "lock" ? undefined : passphrase);
        setPassphrase("");
        setFeedback({
          type: "ok",
          message:
            action === "init"
              ? "Vault initialized successfully."
              : action === "unlock"
                ? "Vault unlocked."
                : "Vault locked.",
        });
      } catch (err) {
        setFeedback({
          type: "error",
          message: err instanceof Error ? err.message : "Vault action failed.",
        });
      } finally {
        setBusy(false);
      }
    },
    [vaultAction, passphrase],
  );

  const initialized = vaultStatus?.initialized ?? false;
  const unlocked = vaultStatus?.unlocked ?? false;
  const keyCount = vaultStatus?.keyCount ?? 0;

  let stateIcon = <ShieldOff className="h-5 w-5 text-muted-foreground" />;
  let stateLabel = "Not Initialized";
  let stateBadgeVariant: "destructive" | "default" | "secondary" = "destructive";

  if (initialized && unlocked) {
    stateIcon = <ShieldCheck className="h-5 w-5 text-emerald-500" />;
    stateLabel = "Unlocked";
    stateBadgeVariant = "default";
  } else if (initialized && !unlocked) {
    stateIcon = <Shield className="h-5 w-5 text-amber-500" />;
    stateLabel = "Locked";
    stateBadgeVariant = "secondary";
  }

  return (
    <div className="space-y-4">
      <Card className="bg-card/60">
        <CardHeader>
          <CardTitle className="text-base">Vault Status</CardTitle>
          <CardDescription>Secure secret storage for API keys and credentials.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg border bg-background/50 px-4 py-3">
            {stateIcon}
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">State</p>
                <Badge variant={stateBadgeVariant} className="text-[10px]">
                  {stateLabel}
                </Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {initialized
                  ? `${keyCount} secret${keyCount !== 1 ? "s" : ""} stored`
                  : "Initialize the vault to start storing secrets securely."}
              </p>
            </div>
          </div>

          {!initialized && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vault-passphrase" className="text-xs text-muted-foreground">
                  Passphrase
                </Label>
                <Input
                  id="vault-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter a strong passphrase"
                />
              </div>
              <Button
                onClick={() => void handleVaultAction("init")}
                disabled={busy || !passphrase}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Key className="mr-1.5 h-4 w-4" />
                )}
                Initialize Vault
              </Button>
            </div>
          )}

          {initialized && !unlocked && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vault-unlock" className="text-xs text-muted-foreground">
                  Passphrase
                </Label>
                <Input
                  id="vault-unlock"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter vault passphrase"
                />
              </div>
              <Button
                onClick={() => void handleVaultAction("unlock")}
                disabled={busy || !passphrase}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Unlock className="mr-1.5 h-4 w-4" />
                )}
                Unlock Vault
              </Button>
            </div>
          )}

          {initialized && unlocked && (
            <Button
              variant="outline"
              onClick={() => void handleVaultAction("lock")}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Lock className="mr-1.5 h-4 w-4" />
              )}
              Lock Vault
            </Button>
          )}

          {feedback && (
            <Alert variant={feedback.type === "error" ? "destructive" : "default"}>
              <AlertDescription className="text-xs">{feedback.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General Section
// ---------------------------------------------------------------------------

function GeneralSection() {
  const { agentRuns, runAgentCycle } = useSteward();
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "ok" | "error"; message: string } | null>(null);

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
      const parts = Object.entries(result.summary)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      setFeedback({
        type: "ok",
        message: parts ? `Cycle complete: ${parts}` : "Cycle completed successfully.",
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
              Configured loop interval: <strong className="text-foreground">120s</strong> (default)
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
          <CardTitle className="text-base">Additional Settings</CardTitle>
          <CardDescription>
            Future configuration options will appear here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center">
            <Settings2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Notification channels, autonomy tier defaults, scheduled scan windows, and more
              settings are coming soon.
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure providers, vault, and agent behavior.
        </p>
      </div>

      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="vault">Vault</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>

        <TabsContent value="providers">
          <ProvidersSection />
        </TabsContent>

        <TabsContent value="vault">
          <VaultSection />
        </TabsContent>

        <TabsContent value="general">
          <GeneralSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
