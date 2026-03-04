"use client";

import { useState } from "react";
import {
  Puzzle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Power,
  Loader2,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const CAPABILITY_COLORS: Record<string, string> = {
  discovery: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  playbooks: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  enrichment: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/25",
  protocol: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
};

const STATUS_CONFIG = {
  loaded: { icon: CheckCircle2, label: "Loaded", color: "text-emerald-600 dark:text-emerald-400" },
  error: { icon: XCircle, label: "Error", color: "text-destructive" },
  disabled: { icon: Power, label: "Disabled", color: "text-muted-foreground" },
} as const;

export default function PluginsPage() {
  const { plugins, loading, togglePlugin, reloadPlugins } = useSteward();
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const handleToggle = async (id: string, enabled: boolean) => {
    setTogglingId(id);
    try {
      await togglePlugin(id, enabled);
    } finally {
      setTogglingId(null);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await reloadPlugins();
    } finally {
      setReloading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const loadedCount = plugins.filter((p) => p.status === "loaded").length;
  const totalPages = Math.max(1, Math.ceil(plugins.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedPlugins = plugins.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Extend Steward with custom discovery, playbooks, and device adapters.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleReload} disabled={reloading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", reloading && "animate-spin")} />
          {reloading ? "Reloading..." : "Reload Plugins"}
        </Button>
      </div>

      {/* Summary */}
      <Card className="bg-card/85">
        <CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Puzzle className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {plugins.length} plugin{plugins.length !== 1 ? "s" : ""} installed
              {loadedCount > 0 && <span className="text-muted-foreground"> · {loadedCount} active</span>}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Plugin List */}
      {plugins.length === 0 ? (
        <Card className="bg-card/85">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <Puzzle className="h-12 w-12 text-muted-foreground/30" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">No plugins installed</p>
              <p className="max-w-md text-xs text-muted-foreground/70">
                To add a plugin, create a directory in your Steward data folder under{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">plugins/</code> with a{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">manifest.json</code> and an{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">index.js</code> entry file,
                then click &quot;Reload Plugins&quot;.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pagedPlugins.map((plugin) => {
            const statusCfg = STATUS_CONFIG[plugin.status];
            const StatusIcon = statusCfg.icon;
            const isToggling = togglingId === plugin.id;

            return (
              <Card key={plugin.id} className={cn("bg-card/85", !plugin.enabled && "opacity-70")}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base">{plugin.name}</CardTitle>
                        <Badge variant="outline" className="text-[10px]">
                          v{plugin.version}
                        </Badge>
                      </div>
                      <CardDescription className="mt-1">{plugin.description}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {isToggling && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      <Switch
                        checked={plugin.enabled}
                        onCheckedChange={(checked) => handleToggle(plugin.id, checked)}
                        disabled={isToggling}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Capabilities */}
                  <div className="flex flex-wrap gap-1.5">
                    {plugin.provides.map((cap) => (
                      <span
                        key={cap}
                        className={cn(
                          "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize",
                          CAPABILITY_COLORS[cap] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {cap}
                      </span>
                    ))}
                  </div>

                  {/* Status */}
                  <div className="flex items-center justify-between">
                    <div className={cn("flex items-center gap-1.5 text-xs", statusCfg.color)}>
                      <StatusIcon className="h-3.5 w-3.5" />
                      <span>{statusCfg.label}</span>
                    </div>
                    {plugin.author && (
                      <span className="text-[10px] text-muted-foreground">
                        by {plugin.author}
                      </span>
                    )}
                  </div>

                  {/* Error message */}
                  {plugin.status === "error" && plugin.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <p className="text-xs text-destructive">{plugin.error}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {plugins.length > pageSize && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>Prev</Button>
          <span className="text-xs text-muted-foreground tabular-nums">Page {currentPage} / {totalPages}</span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>Next</Button>
        </div>
      )}
    </div>
  );
}
