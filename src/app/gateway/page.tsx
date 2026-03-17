"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Send, Sparkles } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface GatewayBinding {
  id: string;
  name: string;
  enabled: boolean;
  target: string;
  hasSecret: boolean;
  webhookSecretConfigured: boolean;
  defaultThreadTitle?: string;
  configJson: {
    transportMode?: "polling" | "webhook";
    webhookUrl?: string;
    pollingLastSyncAt?: string;
  };
  lastInboundAt?: string;
  lastOutboundAt?: string;
}

interface BriefingItem {
  id: string;
  title: string;
  delivered: boolean;
  createdAt: string;
  bindingId?: string;
}

function formatWhen(value?: string): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function GatewayPage() {
  const [bindings, setBindings] = useState<GatewayBinding[]>([]);
  const [briefings, setBriefings] = useState<BriefingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "Telegram Ops",
    botToken: "",
    transportMode: "polling" as "polling" | "webhook",
    webhookUrl: "",
    target: "",
    defaultThreadTitle: "",
    webhookSecret: "",
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [bindingResponse, briefingResponse] = await Promise.all([
        fetchClientJson<{ bindings: GatewayBinding[] }>("/api/gateway/bindings"),
        fetchClientJson<{ briefings: BriefingItem[] }>("/api/briefings"),
      ]);
      setBindings(bindingResponse.bindings);
      setBriefings(briefingResponse.briefings);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load gateway state");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createBinding = async () => {
    setWorking(true);
    setError(null);
    try {
      await fetchClientJson("/api/gateway/bindings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: form.name,
          botToken: form.botToken || undefined,
          transportMode: form.transportMode,
          webhookUrl: form.transportMode === "webhook" ? form.webhookUrl || undefined : undefined,
          target: form.target,
          defaultThreadTitle: form.defaultThreadTitle || undefined,
          webhookSecret: form.webhookSecret || undefined,
        }),
      });
      setForm({
        name: "Telegram Ops",
        botToken: "",
        transportMode: "polling",
        webhookUrl: "",
        target: "",
        defaultThreadTitle: "",
        webhookSecret: "",
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create binding");
    } finally {
      setWorking(false);
    }
  };

  const toggleBinding = async (binding: GatewayBinding) => {
    setWorking(true);
    setError(null);
    try {
      await fetchClientJson(`/api/gateway/bindings/${binding.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enabled: !binding.enabled,
        }),
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update binding");
    } finally {
      setWorking(false);
    }
  };

  const queueBriefing = async (bindingId?: string) => {
    setWorking(true);
    setError(null);
    try {
      await fetchClientJson("/api/briefings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bindingId,
        }),
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to queue briefing");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-auto pr-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Send className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="steward-heading-font text-2xl font-semibold tracking-tight">Gateway</h1>
            <p className="text-sm text-muted-foreground">
              Telegram-first operator presence for briefings, approvals, and mission visibility.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || working}>
          {(loading || working) ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>Create Telegram Binding</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="gateway-name">Name</Label>
              <Input id="gateway-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gateway-token">Bot Token</Label>
              <Input id="gateway-token" type="password" value={form.botToken} onChange={(event) => setForm((current) => ({ ...current, botToken: event.target.value }))} />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="gateway-transport">Delivery Mode</Label>
                <Select value={form.transportMode} onValueChange={(value: "polling" | "webhook") => setForm((current) => ({ ...current, transportMode: value }))}>
                  <SelectTrigger id="gateway-transport">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="polling">Local polling</SelectItem>
                    <SelectItem value="webhook">Public webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.transportMode === "webhook" ? (
                <div className="grid gap-2">
                  <Label htmlFor="gateway-webhook">Webhook URL</Label>
                  <Input id="gateway-webhook" value={form.webhookUrl} onChange={(event) => setForm((current) => ({ ...current, webhookUrl: event.target.value }))} placeholder="https://steward.example.com/api/gateway/telegram/<bindingId>/webhook" />
                </div>
              ) : (
                <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Steward can poll Telegram directly from the control plane. No public URL is required in local-only mode.
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="gateway-target">Target Thread Key</Label>
              <Input id="gateway-target" value={form.target} onChange={(event) => setForm((current) => ({ ...current, target: event.target.value }))} placeholder="Leave blank to adopt the first inbound thread" />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="gateway-title">Default Thread Title</Label>
                <Input id="gateway-title" value={form.defaultThreadTitle} onChange={(event) => setForm((current) => ({ ...current, defaultThreadTitle: event.target.value }))} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="gateway-secret">Webhook Secret</Label>
                <Input id="gateway-secret" value={form.webhookSecret} onChange={(event) => setForm((current) => ({ ...current, webhookSecret: event.target.value }))} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave the target blank if you want Steward to bind to the first chat or topic that messages the bot after Telegram is connected.
            </p>
            <Button onClick={() => void createBinding()} disabled={working}>
              {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
              Create Binding
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Briefings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading
              ? [1, 2, 3].map((item) => <Skeleton key={item} className="h-14" />)
              : briefings.slice(0, 6).map((briefing) => (
                <div key={briefing.id} className="rounded-lg border border-border/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{briefing.title}</p>
                      <p className="text-xs text-muted-foreground">{formatWhen(briefing.createdAt)}</p>
                    </div>
                    <Badge variant={briefing.delivered ? "default" : "outline"}>
                      {briefing.delivered ? "Delivered" : "Stored"}
                    </Badge>
                  </div>
                </div>
              ))}
            <Button variant="outline" className="w-full" disabled={working} onClick={() => void queueBriefing()}>
              {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
              Queue Global Briefing
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="min-h-0 flex-1">
        <CardHeader>
          <CardTitle>Bindings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {loading
            ? [1, 2].map((item) => <Skeleton key={item} className="h-48" />)
            : bindings.map((binding) => (
              <div key={binding.id} className="rounded-xl border border-border/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{binding.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Target: {binding.target || "Awaiting first inbound thread"}
                    </p>
                  </div>
                  <Badge variant={binding.enabled ? "default" : "outline"}>
                    {binding.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="outline">{binding.configJson.transportMode === "webhook" ? "Webhook" : "Polling"}</Badge>
                  <Badge variant="outline">{binding.hasSecret ? "Token stored" : "No token"}</Badge>
                  <Badge variant="outline">{binding.webhookSecretConfigured ? "Webhook secret set" : "No webhook secret"}</Badge>
                </div>
                <div className="mt-4 space-y-1 text-xs text-muted-foreground">
                  <p>Webhook URL: {binding.configJson.transportMode === "webhook" ? binding.configJson.webhookUrl || "Not configured" : "Not required in polling mode"}</p>
                  <p>Polling sync: {formatWhen(binding.configJson.pollingLastSyncAt)}</p>
                  <p>Last inbound: {formatWhen(binding.lastInboundAt)}</p>
                  <p>Last outbound: {formatWhen(binding.lastOutboundAt)}</p>
                </div>
                <div className="mt-4 flex gap-2">
                  <Button variant="outline" disabled={working} onClick={() => void toggleBinding(binding)}>
                    {binding.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button disabled={working} onClick={() => void queueBriefing(binding.id)}>
                    Send Briefing
                  </Button>
                </div>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
