"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Puzzle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Power,
  Loader2,
  SlidersHorizontal,
  Wrench,
  FileCode2,
  Search,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useSteward,
  type AdapterPackageClient,
  type AdapterRecordClient,
} from "@/lib/hooks/use-steward";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

const CAPABILITY_COLORS: Record<string, string> = {
  discovery: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  playbooks: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  enrichment: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/25",
  protocol: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
};

const STATUS_CONFIG = {
  loaded: { icon: CheckCircle2, label: "Loaded", color: "text-emerald-600 dark:text-emerald-400" },
  error: { icon: XCircle, label: "Error", color: "text-destructive" },
  disabled: { icon: Power, label: "Disabled", color: "text-muted-foreground" },
} as const;

const TOOL_OPERATION_KIND_OPTIONS = [
  "shell.command",
  "service.restart",
  "service.stop",
  "container.restart",
  "container.stop",
  "http.request",
  "cert.renew",
  "file.copy",
  "network.config",
] as const;

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stringifyConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

const DEFAULT_MANIFEST_TEMPLATE: Record<string, unknown> = {
  id: "custom.example.adapter",
  name: "Custom Adapter",
  description: "User-managed adapter package.",
  version: "1.0.0",
  author: "Steward User",
  entry: "index.js",
  provides: ["enrichment"],
  configSchema: [],
  defaultConfig: {},
  toolSkills: [
    {
      id: "skill.custom.example",
      name: "Custom Example",
      description: "Example custom tool skill.",
      category: "operations",
      operationKinds: ["shell.command"],
      enabledByDefault: true,
      toolCall: {
        name: "custom_example",
        description: "Run the custom example skill.",
        parameters: {
          type: "object",
          properties: {
            device_id: { type: "string" },
            input: { type: "object", additionalProperties: true },
          },
          required: ["device_id"],
          additionalProperties: true,
        },
      },
      execution: {
        kind: "shell.command",
        mode: "read",
        adapterId: "ssh",
        commandTemplate: "ssh {{host}} 'uname -a; uptime'",
      },
      skillMdPath: "skills/skill.custom.example.md",
    },
  ],
  defaultToolConfig: {
    "skill.custom.example": {
      enabled: true,
    },
  },
  skillMdPath: "SKILL.md",
};

const DEFAULT_ENTRY_SOURCE = `module.exports = {
  activate(context) {
    context.log("info", "Custom adapter activated");
  },
};
`;

export default function AdaptersPage() {
  const {
    adapters,
    loading,
    toggleAdapter,
    reloadAdapters,
    updateAdapterConfig,
    getAdapterPackage,
    createAdapterPackage,
    updateAdapterPackage,
    deleteAdapterPackage,
  } = useSteward();

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeAdapter, setActiveAdapter] = useState<AdapterRecordClient | null>(null);
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>({});
  const [draftToolConfig, setDraftToolConfig] = useState<Record<string, Record<string, unknown>>>({});
  const [rawConfig, setRawConfig] = useState("{}");
  const [rawToolConfig, setRawToolConfig] = useState("{}");
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [activePackageAdapter, setActivePackageAdapter] = useState<AdapterRecordClient | null>(null);
  const [editingPackage, setEditingPackage] = useState<AdapterPackageClient | null>(null);
  const [packageManifestRaw, setPackageManifestRaw] = useState("{}");
  const [packageEntryRaw, setPackageEntryRaw] = useState(DEFAULT_ENTRY_SOURCE);
  const [packageSkillMdRaw, setPackageSkillMdRaw] = useState("");
  const [packageToolMdRaw, setPackageToolMdRaw] = useState("{}");
  const [packageLoading, setPackageLoading] = useState(false);
  const [packageSaving, setPackageSaving] = useState(false);
  const [packageDeleting, setPackageDeleting] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageNotice, setPackageNotice] = useState<string | null>(null);
  const [packageDialogOpen, setPackageDialogOpen] = useState(false);

  const pageSize = 8;

  const handleToggle = async (id: string, enabled: boolean) => {
    setTogglingId(id);
    try {
      await toggleAdapter(id, enabled);
    } finally {
      setTogglingId(null);
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await reloadAdapters();
    } finally {
      setReloading(false);
    }
  };

  const openConfig = (adapter: AdapterRecordClient) => {
    setActiveAdapter(adapter);
    setDraftConfig({ ...(adapter.config ?? {}) });
    setDraftToolConfig({ ...(adapter.toolConfig ?? {}) });
    setRawConfig(stringifyConfig(adapter.config ?? {}));
    setRawToolConfig(stringifyConfig(adapter.toolConfig ?? {}));
    setConfigError(null);
    setConfigNotice(null);
  };

  const updateField = (key: string, value: unknown) => {
    setDraftConfig((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      setRawConfig(stringifyConfig(next));
      return next;
    });
  };

  const applyRawConfig = () => {
    try {
      const parsed = JSON.parse(rawConfig) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setConfigError("Adapter config JSON must be an object.");
        return;
      }
      setDraftConfig(parsed as Record<string, unknown>);
      setConfigError(null);
      setConfigNotice("Applied JSON to form state.");
    } catch {
      setConfigError("Invalid JSON. Fix syntax and try again.");
    }
  };

  const updateToolEnabled = (skillId: string, enabled: boolean) => {
    setDraftToolConfig((prev) => {
      const next = {
        ...prev,
        [skillId]: {
          ...(prev[skillId] ?? {}),
          enabled,
        },
      };
      setRawToolConfig(stringifyConfig(next));
      return next;
    });
  };

  const updateToolConfig = (
    skillId: string,
    updater: (current: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    setDraftToolConfig((prev) => {
      const current = prev[skillId] ?? {};
      const nextSkillConfig = updater(current);
      const next = {
        ...prev,
        [skillId]: nextSkillConfig,
      };
      setRawToolConfig(stringifyConfig(next));
      return next;
    });
  };

  const updateToolExecutionField = (
    skillId: string,
    key: string,
    value: unknown,
  ) => {
    updateToolConfig(skillId, (current) => {
      const baseExecution = current.execution && typeof current.execution === "object" && !Array.isArray(current.execution)
        ? { ...(current.execution as Record<string, unknown>) }
        : {};

      if (value === undefined || value === "") {
        delete baseExecution[key];
      } else {
        baseExecution[key] = value;
      }

      const next = { ...current };
      if (Object.keys(baseExecution).length === 0) {
        delete next.execution;
      } else {
        next.execution = baseExecution;
      }

      return next;
    });
  };

  const updateToolExecutionTemplate = (
    skillId: string,
    kind: string,
    value: string,
  ) => {
    updateToolConfig(skillId, (current) => {
      const execution = current.execution && typeof current.execution === "object" && !Array.isArray(current.execution)
        ? { ...(current.execution as Record<string, unknown>) }
        : {};

      const templates = execution.commandTemplates
        && typeof execution.commandTemplates === "object"
        && !Array.isArray(execution.commandTemplates)
        ? { ...(execution.commandTemplates as Record<string, unknown>) }
        : {};

      const trimmed = value.trim();
      if (!trimmed) {
        delete templates[kind];
      } else {
        templates[kind] = value;
      }

      if (Object.keys(templates).length === 0) {
        delete execution.commandTemplates;
      } else {
        execution.commandTemplates = templates;
      }

      const next = { ...current };
      if (Object.keys(execution).length === 0) {
        delete next.execution;
      } else {
        next.execution = execution;
      }

      return next;
    });
  };

  const applyRawToolConfig = () => {
    try {
      const parsed = JSON.parse(rawToolConfig) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setConfigError("Tool config JSON must be an object keyed by tool skill id.");
        return;
      }
      setDraftToolConfig(parsed as Record<string, Record<string, unknown>>);
      setConfigError(null);
      setConfigNotice("Applied tool JSON to state.");
    } catch {
      setConfigError("Invalid tool JSON. Fix syntax and try again.");
    }
  };

  const saveConfig = async () => {
    if (!activeAdapter) {
      return;
    }

    setSavingConfig(true);
    setConfigError(null);
    setConfigNotice(null);

    try {
      const result = await updateAdapterConfig(activeAdapter.id, {
        config: draftConfig,
        mode: "replace",
        toolConfig: draftToolConfig,
        toolMode: "replace",
      });
      setActiveAdapter(result);
      setDraftConfig({ ...(result.config ?? {}) });
      setDraftToolConfig({ ...(result.toolConfig ?? {}) });
      setRawConfig(stringifyConfig(result.config ?? {}));
      setRawToolConfig(stringifyConfig(result.toolConfig ?? {}));
      setConfigNotice("Adapter configuration saved.");
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Failed to save adapter configuration.");
    } finally {
      setSavingConfig(false);
    }
  };

  const closeConfig = () => {
    setActiveAdapter(null);
    setConfigError(null);
    setConfigNotice(null);
  };

  const openCreatePackage = () => {
    setPackageDialogOpen(true);
    setActivePackageAdapter(null);
    setEditingPackage(null);
    setPackageManifestRaw(JSON.stringify(DEFAULT_MANIFEST_TEMPLATE, null, 2));
    setPackageEntryRaw(DEFAULT_ENTRY_SOURCE);
    setPackageSkillMdRaw("# Custom Adapter\n");
    setPackageToolMdRaw(
      JSON.stringify(
        {
          "skill.custom.example": "# Custom Example\n",
        },
        null,
        2,
      ),
    );
    setPackageLoading(false);
    setPackageSaving(false);
    setPackageDeleting(false);
    setPackageError(null);
    setPackageNotice(null);
  };

  const openEditPackage = async (adapter: AdapterRecordClient) => {
    setPackageDialogOpen(true);
    setActivePackageAdapter(adapter);
    setPackageError(null);
    setPackageNotice(null);
    setPackageLoading(true);
    try {
      const pkg = await getAdapterPackage(adapter.id);
      setEditingPackage(pkg);
      setPackageManifestRaw(JSON.stringify(pkg.manifest, null, 2));
      setPackageEntryRaw(pkg.entrySource || "");
      setPackageSkillMdRaw(pkg.adapterSkillMd ?? "");
      setPackageToolMdRaw(JSON.stringify(pkg.toolSkillMd ?? {}, null, 2));
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : "Failed to load adapter package.");
    } finally {
      setPackageLoading(false);
    }
  };

  const closePackageEditor = () => {
    setPackageDialogOpen(false);
    setActivePackageAdapter(null);
    setEditingPackage(null);
    setPackageSaving(false);
    setPackageDeleting(false);
    setPackageError(null);
    setPackageNotice(null);
    setPackageLoading(false);
  };

  const savePackage = async () => {
    setPackageSaving(true);
    setPackageError(null);
    setPackageNotice(null);
    try {
      const manifestParsed = JSON.parse(packageManifestRaw) as unknown;
      if (!manifestParsed || typeof manifestParsed !== "object" || Array.isArray(manifestParsed)) {
        throw new Error("Manifest JSON must be an object.");
      }

      const toolMdParsed = JSON.parse(packageToolMdRaw) as unknown;
      if (!toolMdParsed || typeof toolMdParsed !== "object" || Array.isArray(toolMdParsed)) {
        throw new Error("Tool markdown JSON must be an object keyed by skill id.");
      }

      const toolSkillMd: Record<string, string> = {};
      for (const [skillId, value] of Object.entries(toolMdParsed as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error(`Tool markdown for '${skillId}' must be a string.`);
        }
        toolSkillMd[skillId] = value;
      }

      const payload = {
        manifest: manifestParsed as Record<string, unknown>,
        entrySource: packageEntryRaw,
        adapterSkillMd: packageSkillMdRaw,
        toolSkillMd,
      };

      const pkg = activePackageAdapter
        ? await updateAdapterPackage(activePackageAdapter.id, payload)
        : await createAdapterPackage(payload);

      setActivePackageAdapter(pkg.adapter);
      setEditingPackage(pkg);
      setPackageManifestRaw(JSON.stringify(pkg.manifest, null, 2));
      setPackageEntryRaw(pkg.entrySource || "");
      setPackageSkillMdRaw(pkg.adapterSkillMd ?? "");
      setPackageToolMdRaw(JSON.stringify(pkg.toolSkillMd ?? {}, null, 2));
      setPackageNotice(activePackageAdapter ? "Adapter package updated." : "Adapter package created.");
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : "Failed to save adapter package.");
    } finally {
      setPackageSaving(false);
    }
  };

  const deletePackage = async () => {
    if (!activePackageAdapter) {
      return;
    }

    const confirmed = window.confirm(`Delete adapter '${activePackageAdapter.name}'? This removes its files.`);
    if (!confirmed) {
      return;
    }

    setPackageDeleting(true);
    setPackageError(null);
    setPackageNotice(null);
    try {
      await deleteAdapterPackage(activePackageAdapter.id);
      closePackageEditor();
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : "Failed to delete adapter.");
    } finally {
      setPackageDeleting(false);
    }
  };

  const loadedCount = useMemo(
    () => adapters.filter((adapter) => adapter.status === "loaded").length,
    [adapters],
  );

  const filteredAdapters = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return adapters;
    }

    return adapters.filter((adapter) => {
      const searchable = [
        adapter.name,
        adapter.id,
        adapter.description,
        adapter.author,
        adapter.version,
        ...adapter.provides,
        ...adapter.toolSkills.map((skill) => skill.id),
        ...adapter.toolSkills.map((skill) => skill.name),
        ...adapter.toolSkills.map((skill) => skill.description),
        ...adapter.toolSkills.map((skill) => skill.category ?? ""),
        ...adapter.toolSkills.flatMap((skill) => skill.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();

      return searchable.includes(query);
    });
  }, [adapters, searchQuery]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredAdapters.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedAdapters = filteredAdapters.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">Adapters</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure adapter runtime behavior, capabilities, discovery scope, and tool skills.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-72">
          <Button variant="default" size="sm" onClick={openCreatePackage}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create Adapter
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search adapters, tools, capabilities..."
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={handleReload} disabled={reloading}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", reloading && "animate-spin")} />
            {reloading ? "Reloading..." : "Reload Adapters"}
          </Button>
        </div>
      </div>

      <Card className="bg-card/85">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Puzzle className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {adapters.length} adapter{adapters.length !== 1 ? "s" : ""} installed
              {loadedCount > 0 && <span className="text-muted-foreground"> · {loadedCount} active</span>}
              {searchQuery.trim().length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  · {filteredAdapters.length} shown
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              Fully DB-backed config with schema-driven UI and JSON fallback.
            </p>
          </div>
        </CardContent>
      </Card>

      {adapters.length === 0 ? (
        <Card className="bg-card/85">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <Puzzle className="h-12 w-12 text-muted-foreground/30" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">No adapters installed</p>
              <p className="max-w-md text-xs text-muted-foreground/70">
                Built-in adapters are seeded automatically in your data directory. If this list is empty,
                use &quot;Reload Adapters&quot; to reconcile disk and database state.
              </p>
              <Button size="sm" onClick={openCreatePackage}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create Adapter Package
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : filteredAdapters.length === 0 ? (
        <Card className="bg-card/85">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <Search className="h-10 w-10 text-muted-foreground/40" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">No adapters match your search</p>
              <p className="max-w-md text-xs text-muted-foreground/70">
                Try searching by adapter name, id, capability, or tool skill.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pagedAdapters.map((adapter) => {
            const statusCfg = STATUS_CONFIG[adapter.status];
            const StatusIcon = statusCfg.icon;
            const isToggling = togglingId === adapter.id;

            return (
              <Card key={adapter.id} className={cn("bg-card/85", !adapter.enabled && "opacity-75")}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-base">{adapter.name}</CardTitle>
                        <Badge variant="outline" className="text-[10px]">v{adapter.version}</Badge>
                        <Badge variant="outline" className="text-[10px] uppercase">
                          {adapter.source}
                        </Badge>
                      </div>
                      <CardDescription>{adapter.description}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      {isToggling && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      <Switch
                        checked={adapter.enabled}
                        onCheckedChange={(checked) => handleToggle(adapter.id, checked)}
                        disabled={isToggling}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {adapter.provides.map((capability) => (
                      <span
                        key={capability}
                        className={cn(
                          "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium capitalize",
                          CAPABILITY_COLORS[capability] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {capability}
                      </span>
                    ))}
                  </div>

                  <div className="flex items-center justify-between">
                    <div className={cn("flex items-center gap-1.5 text-xs", statusCfg.color)}>
                      <StatusIcon className="h-3.5 w-3.5" />
                      <span>{statusCfg.label}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      {adapter.author && <span>by {adapter.author}</span>}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <SlidersHorizontal className="h-3 w-3" />
                      {adapter.configSchema.length} configurable field{adapter.configSchema.length !== 1 ? "s" : ""}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Wrench className="h-3 w-3" />
                      {adapter.toolSkills.length} tool skill{adapter.toolSkills.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={() => openConfig(adapter)}
                    >
                      <FileCode2 className="mr-1.5 h-3.5 w-3.5" />
                      Runtime Config
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => void openEditPackage(adapter)}
                    >
                      <FileCode2 className="mr-1.5 h-3.5 w-3.5" />
                      Edit Package
                    </Button>
                  </div>

                  {adapter.status === "error" && adapter.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <p className="text-xs text-destructive">{adapter.error}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {filteredAdapters.length > pageSize && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            Prev
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">Page {currentPage} / {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
          >
            Next
          </Button>
        </div>
      )}

      <Dialog open={Boolean(activeAdapter)} onOpenChange={(open) => !open && closeConfig()}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Configure {activeAdapter?.name}</DialogTitle>
            <DialogDescription>
              Edit DB-backed runtime settings. File adapters remain source-of-truth for code and manifest shape.
            </DialogDescription>
          </DialogHeader>

          {activeAdapter && (
            <div className="space-y-4">
              <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="text-[10px] uppercase">{activeAdapter.source}</Badge>
                  <code className="rounded bg-background px-1.5 py-0.5">{activeAdapter.id}</code>
                </div>
                {activeAdapter.location && (
                  <p className="text-muted-foreground">Path: <code>{activeAdapter.location}</code></p>
                )}
                {activeAdapter.skillMdPath && (
                  <p className="text-muted-foreground">
                    Adapter skill markdown: <code>{activeAdapter.skillMdPath}</code>
                  </p>
                )}
              </div>

              {activeAdapter.configSchema.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {activeAdapter.configSchema.map((field) => {
                    const currentValue = draftConfig[field.key] ?? field.default;

                    if (field.type === "boolean") {
                      return (
                        <div key={field.key} className="space-y-2 rounded-md border p-3">
                          <div>
                            <Label className="text-xs">{field.label}</Label>
                            {field.description && <p className="mt-1 text-[11px] text-muted-foreground">{field.description}</p>}
                          </div>
                          <Switch
                            checked={Boolean(currentValue)}
                            onCheckedChange={(checked) => updateField(field.key, checked)}
                          />
                        </div>
                      );
                    }

                    if (field.type === "number") {
                      return (
                        <div key={field.key} className="space-y-2 rounded-md border p-3">
                          <Label className="text-xs">{field.label}</Label>
                          {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
                          <Input
                            type="number"
                            min={field.min}
                            max={field.max}
                            value={typeof currentValue === "number" ? currentValue : ""}
                            onChange={(event) => {
                              const raw = event.target.value;
                              updateField(field.key, raw === "" ? undefined : Number(raw));
                            }}
                          />
                        </div>
                      );
                    }

                    if (field.type === "select") {
                      return (
                        <div key={field.key} className="space-y-2 rounded-md border p-3">
                          <Label className="text-xs">{field.label}</Label>
                          {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
                          <Select
                            value={currentValue === undefined ? undefined : JSON.stringify(currentValue)}
                            onValueChange={(value) => updateField(field.key, parseJsonValue(value))}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a value" />
                            </SelectTrigger>
                            <SelectContent>
                              {(field.options ?? []).map((option) => (
                                <SelectItem key={`${field.key}:${String(option.value)}`} value={JSON.stringify(option.value)}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    }

                    if (field.type === "json") {
                      return (
                        <div key={field.key} className="space-y-2 rounded-md border p-3">
                          <Label className="text-xs">{field.label}</Label>
                          {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
                          <p className="text-[11px] text-muted-foreground">
                            Edit this key in the raw JSON editor below.
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div key={field.key} className="space-y-2 rounded-md border p-3">
                        <Label className="text-xs">{field.label}</Label>
                        {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
                        {field.multiline ? (
                          <Textarea
                            value={typeof currentValue === "string" ? currentValue : ""}
                            placeholder={field.placeholder}
                            onChange={(event) => updateField(field.key, event.target.value)}
                          />
                        ) : (
                          <Input
                            type={field.secret ? "password" : "text"}
                            value={typeof currentValue === "string" ? currentValue : ""}
                            placeholder={field.placeholder}
                            onChange={(event) => updateField(field.key, event.target.value)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  This adapter does not declare schema fields. Use raw JSON for advanced settings.
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-xs">Raw Config JSON</Label>
                <Textarea
                  className="min-h-40 font-mono text-xs"
                  value={rawConfig}
                  onChange={(event) => setRawConfig(event.target.value)}
                />
                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={applyRawConfig}>
                    Apply JSON to Form
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Tool Skills</Label>
                {activeAdapter.toolSkills.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No tool skills declared by this adapter.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {activeAdapter.toolSkills.map((skill) => (
                      <div key={skill.id} className="rounded-md border p-3">
                        {(() => {
                          const effectiveEnabled = typeof draftToolConfig[skill.id]?.enabled === "boolean"
                            ? Boolean(draftToolConfig[skill.id]?.enabled)
                            : (skill.enabledByDefault ?? true);
                          const runtimeConfig = draftToolConfig[skill.id] ?? { enabled: effectiveEnabled };
                          const execution = runtimeConfig.execution && typeof runtimeConfig.execution === "object" && !Array.isArray(runtimeConfig.execution)
                            ? (runtimeConfig.execution as Record<string, unknown>)
                            : {};
                          const commandTemplates = execution.commandTemplates
                            && typeof execution.commandTemplates === "object"
                            && !Array.isArray(execution.commandTemplates)
                            ? (execution.commandTemplates as Record<string, unknown>)
                            : {};

                          return (
                            <>
                        <div className="flex items-center justify-between gap-2">
                          <div className="space-y-1">
                            <p className="text-xs font-medium">{skill.name}</p>
                            <p className="text-[11px] text-muted-foreground">{skill.id}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {skill.category && <Badge variant="outline" className="text-[10px]">{skill.category}</Badge>}
                            <Switch
                              checked={effectiveEnabled}
                              onCheckedChange={(checked) => updateToolEnabled(skill.id, checked)}
                            />
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
                        {skill.toolCall && (
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            Tool call: <code>{skill.toolCall.name}</code>
                          </p>
                        )}
                        {skill.operationKinds && skill.operationKinds.length > 0 && (
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            Operations: {skill.operationKinds.join(", ")}
                          </p>
                        )}
                        {skill.skillMdPath && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Skill markdown: <code>{skill.skillMdPath}</code>
                          </p>
                        )}

                        <div className="mt-3 rounded-md border bg-muted/25 p-2.5">
                          <p className="text-[11px] font-medium">Execution Defaults</p>
                          <p className="text-[10px] text-muted-foreground">
                            Configure how this tool skill executes in chat for custom and imported adapters.
                          </p>

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div className="space-y-1.5">
                              <Label className="text-[10px]">Operation Kind</Label>
                              <Select
                                value={typeof execution.kind === "string" ? execution.kind : "__auto__"}
                                onValueChange={(value) => updateToolExecutionField(skill.id, "kind", value === "__auto__" ? undefined : value)}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder="Auto" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__auto__">Auto</SelectItem>
                                  {TOOL_OPERATION_KIND_OPTIONS.map((kind) => (
                                    <SelectItem key={`${skill.id}:kind:${kind}`} value={kind}>{kind}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-[10px]">Mode</Label>
                              <Select
                                value={execution.mode === "read" || execution.mode === "mutate" ? execution.mode : "__auto__"}
                                onValueChange={(value) => updateToolExecutionField(skill.id, "mode", value === "__auto__" ? undefined : value)}
                              >
                                <SelectTrigger className="h-8 text-xs">
                                  <SelectValue placeholder="Auto" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__auto__">Auto</SelectItem>
                                  <SelectItem value="read">read</SelectItem>
                                  <SelectItem value="mutate">mutate</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-[10px]">Adapter ID Override</Label>
                              <Input
                                className="h-8 text-xs"
                                placeholder="auto"
                                value={typeof execution.adapterId === "string" ? execution.adapterId : ""}
                                onChange={(event) => updateToolExecutionField(skill.id, "adapterId", event.target.value || undefined)}
                              />
                            </div>

                            <div className="space-y-1.5">
                              <Label className="text-[10px]">Timeout (ms)</Label>
                              <Input
                                className="h-8 text-xs"
                                type="number"
                                min={1000}
                                max={600000}
                                placeholder="auto"
                                value={typeof execution.timeoutMs === "number" ? execution.timeoutMs : ""}
                                onChange={(event) => {
                                  const raw = event.target.value.trim();
                                  updateToolExecutionField(skill.id, "timeoutMs", raw ? Number(raw) : undefined);
                                }}
                              />
                            </div>

                            <div className="space-y-1.5 md:col-span-2">
                              <Label className="text-[10px]">Expected Semantic Target</Label>
                              <Input
                                className="h-8 text-xs"
                                placeholder="skill.custom.example:shell.command"
                                value={typeof execution.expectedSemanticTarget === "string" ? execution.expectedSemanticTarget : ""}
                                onChange={(event) => updateToolExecutionField(skill.id, "expectedSemanticTarget", event.target.value || undefined)}
                              />
                            </div>

                            <div className="space-y-1.5 md:col-span-2">
                              <Label className="text-[10px]">Command Template (fallback)</Label>
                              <Textarea
                                className="min-h-20 font-mono text-[11px]"
                                placeholder="ssh {{host}} 'uname -a'"
                                value={typeof execution.commandTemplate === "string" ? execution.commandTemplate : ""}
                                onChange={(event) => updateToolExecutionField(skill.id, "commandTemplate", event.target.value || undefined)}
                              />
                            </div>
                          </div>

                          {Array.isArray(skill.operationKinds) && skill.operationKinds.length > 0 && (
                            <div className="mt-3 space-y-1.5">
                              <Label className="text-[10px]">Per-Operation Templates</Label>
                              <div className="grid gap-2">
                                {skill.operationKinds.map((kind) => (
                                  <div key={`${skill.id}:tmpl:${kind}`} className="space-y-1">
                                    <Label className="text-[10px] text-muted-foreground">{kind}</Label>
                                    <Textarea
                                      className="min-h-16 font-mono text-[11px]"
                                      placeholder={`Template for ${kind}`}
                                      value={typeof commandTemplates[kind] === "string" ? String(commandTemplates[kind]) : ""}
                                      onChange={(event) => updateToolExecutionTemplate(skill.id, kind, event.target.value)}
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        <div className="mt-2 rounded bg-muted/40 p-2 text-[11px]">
                          <p className="font-medium">Runtime tool config</p>
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px] text-muted-foreground">
                            {JSON.stringify(runtimeConfig, null, 2)}
                          </pre>
                        </div>
                            </>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Raw Tool Config JSON</Label>
                <Textarea
                  className="min-h-40 font-mono text-xs"
                  value={rawToolConfig}
                  onChange={(event) => setRawToolConfig(event.target.value)}
                />
                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={applyRawToolConfig}>
                    Apply Tool JSON
                  </Button>
                </div>
              </div>

              {configError && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">{configError}</AlertDescription>
                </Alert>
              )}
              {configNotice && !configError && (
                <Alert>
                  <AlertDescription className="text-xs">{configNotice}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeConfig}>
              Close
            </Button>
            <Button onClick={saveConfig} disabled={savingConfig || !activeAdapter}>
              {savingConfig && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={packageDialogOpen} onOpenChange={(open) => !open && closePackageEditor()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{activePackageAdapter ? `Edit Package: ${activePackageAdapter.name}` : "Create Adapter Package"}</DialogTitle>
            <DialogDescription>
              Full package editor for adapter manifest, tool definitions, source code, and skill markdown files.
            </DialogDescription>
          </DialogHeader>

          {packageLoading ? (
            <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading adapter package...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-xs">
                {activePackageAdapter ? (
                  <>
                    <p>
                      Editing adapter: <code>{activePackageAdapter.id}</code>
                    </p>
                    {editingPackage?.isBuiltin && (
                      <p className="text-muted-foreground">
                        Built-in adapter detected. You can edit package files, but delete is blocked.
                      </p>
                    )}
                  </>
                ) : (
                  <p>Create a new adapter. `manifest.id` must be unique.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Manifest JSON (includes tool skill definitions)</Label>
                <Textarea
                  className="min-h-72 font-mono text-xs"
                  value={packageManifestRaw}
                  onChange={(event) => setPackageManifestRaw(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Adapter Entry Source (index.js or manifest.entry)</Label>
                <Textarea
                  className="min-h-60 font-mono text-xs"
                  value={packageEntryRaw}
                  onChange={(event) => setPackageEntryRaw(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Adapter Skill Markdown (SKILL.md)</Label>
                <Textarea
                  className="min-h-36 font-mono text-xs"
                  value={packageSkillMdRaw}
                  onChange={(event) => setPackageSkillMdRaw(event.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Tool Skill Markdown JSON</Label>
                <p className="text-[11px] text-muted-foreground">
                  Object keyed by tool skill id, where each value is markdown content.
                </p>
                <Textarea
                  className="min-h-44 font-mono text-xs"
                  value={packageToolMdRaw}
                  onChange={(event) => setPackageToolMdRaw(event.target.value)}
                />
              </div>

              {packageError && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">{packageError}</AlertDescription>
                </Alert>
              )}
              {packageNotice && !packageError && (
                <Alert>
                  <AlertDescription className="text-xs">{packageNotice}</AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter className="flex w-full items-center justify-between gap-2">
            <div>
              {activePackageAdapter && (
                <Button
                  variant="destructive"
                  onClick={deletePackage}
                  disabled={packageDeleting || packageSaving || packageLoading || Boolean(editingPackage?.isBuiltin)}
                >
                  {packageDeleting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
                  Delete Adapter
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={closePackageEditor} disabled={packageSaving || packageDeleting}>
                Close
              </Button>
              <Button onClick={savePackage} disabled={packageSaving || packageDeleting || packageLoading}>
                {packageSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {activePackageAdapter ? "Save Package" : "Create Package"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
