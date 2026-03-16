"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock,
  Filter,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSteward } from "@/lib/hooks/use-steward";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
import type {
  ActionLog,
  AgentRunRecord,
  ControlPlaneQueueLane,
  ScannerRunRecord,
} from "@/lib/state/types";

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

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

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

// ---------------------------------------------------------------------------
// Actor badge
// ---------------------------------------------------------------------------

function ActorBadge({ actor }: { actor: "steward" | "user" }) {
  return (
    <Badge variant={actor === "steward" ? "default" : "secondary"} className="text-[10px]">
      {actor}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Kind badge
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<string, string> = {
  discover: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25",
  diagnose: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
  remediate: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
  learn: "bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/25",
  config: "bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/25",
  auth: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/25",
  policy: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/25",
  playbook: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/25",
  approval: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/25",
  digest: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/25",
};

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        KIND_COLORS[kind] ?? "bg-muted text-muted-foreground",
      )}
    >
      {kind}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Action Log Entry
// ---------------------------------------------------------------------------

function ActionEntry({ action }: { action: ActionLog }) {
  const [expanded, setExpanded] = useState(false);
  const hasContext = Object.keys(action.context).length > 0;

  return (
    <div className="group rounded-lg border bg-card/60 transition-colors hover:bg-card/90">
      <button
        type="button"
        onClick={() => hasContext && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left",
          hasContext && "cursor-pointer",
        )}
      >
        {/* Expand icon */}
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          {hasContext ? (
            expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )
          ) : (
            <div className="h-4 w-4" />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug">{action.message}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <ActorBadge actor={action.actor} />
            <KindBadge kind={action.kind} />
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatTimestamp(action.at)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              ({relativeTime(action.at)})
            </span>
          </div>
        </div>
      </button>

      {/* Expandable context */}
      {expanded && hasContext && (
        <div className="border-t px-4 py-3">
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(action.context, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run Entry
// ---------------------------------------------------------------------------

function RunEntry({
  run,
  kind,
  fallbackLabel,
}: {
  run: AgentRunRecord | ScannerRunRecord;
  kind: "agent" | "scanner";
  fallbackLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(run.details).length > 0;
  const isRunning = !run.completedAt;
  const wakeReason = typeof run.details.wakeReason === "string" ? run.details.wakeReason : null;
  const discovery = kind === "scanner" ? parseDiscoveryDiagnostics(run.details) : null;
  const enrichment = kind === "scanner" ? parseDiscoveryEnrichmentSummary(run.details) : null;
  const constrainedPhases = constrainedDiscoveryPhases(discovery);
  const deferredPhases = deferredDiscoveryPhases(discovery);
  const slowestPhase = slowestDiscoveryPhase(discovery);
  const queuedEnrichmentPhases = enrichment?.phases.filter((phase) => phase.queued).length ?? 0;
  const busyEnrichmentPhases = enrichment?.phases.filter((phase) => phase.queueBusy).length ?? 0;

  return (
    <div className="group rounded-lg border bg-card/60 transition-colors hover:bg-card/90">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left",
          hasDetails && "cursor-pointer",
        )}
      >
        {/* Icon */}
        <div className="mt-0.5 shrink-0">
          {isRunning ? (
            <Play className="h-4 w-4 animate-pulse text-primary" />
          ) : hasDetails ? (
            expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )
          ) : (
            <Activity className="h-4 w-4 text-muted-foreground" />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium leading-snug">{run.summary || fallbackLabel}</p>
            <Badge variant={run.outcome === "ok" ? "default" : "destructive"} className="text-[10px]">
              {run.outcome}
            </Badge>
            {wakeReason ? (
              <Badge variant="outline" className="text-[10px]">
                {wakeReason.replace(/_/g, " ")}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Started: {formatTimestamp(run.startedAt)} ({relativeTime(run.startedAt)})
            </span>
            {run.completedAt ? (
              <span>
                Completed: {formatTimestamp(run.completedAt)} ({relativeTime(run.completedAt)})
              </span>
            ) : (
              <span className="font-medium text-primary">Running...</span>
            )}
          </div>
          {discovery ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">
                {discovery.scanMode}
              </Badge>
              <span>Discovery {formatDurationMs(discovery.elapsedMs)}</span>
              {discovery.budgetMs ? <span>Budget {formatDurationMs(discovery.budgetMs)}</span> : null}
              {constrainedPhases.length > 0 ? (
                <Badge variant="secondary" className="text-[10px]">
                  {constrainedPhases.length} limited
                </Badge>
              ) : null}
              {deferredPhases.length > 0 ? (
                <Badge variant="outline" className="text-[10px]">
                  {deferredPhases.length} backlog
                </Badge>
              ) : null}
              {discovery.failedPhaseCount > 0 ? (
                <Badge variant="destructive" className="text-[10px]">
                  {discovery.failedPhaseCount} failed
                </Badge>
              ) : null}
              {slowestPhase ? (
                <span>
                  Slowest {slowestPhase.label} {formatDurationMs(slowestPhase.elapsedMs)}
                </span>
              ) : null}
            </div>
          ) : null}
          {enrichment && enrichment.phases.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <Badge variant="secondary" className="text-[10px]">
                background enrichment
              </Badge>
              <span>due {enrichment.dueTargets}</span>
              {enrichment.deferredTargets > 0 ? <span>deferred {enrichment.deferredTargets}</span> : null}
              {queuedEnrichmentPhases > 0 ? <span>queued {queuedEnrichmentPhases}</span> : null}
              {busyEnrichmentPhases > 0 ? <span>{busyEnrichmentPhases} already active</span> : null}
            </div>
          ) : null}
        </div>
      </button>

      {/* Expandable details */}
      {expanded && hasDetails && (
        <div className="border-t px-4 py-3">
          {discovery ? (
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {discovery.phaseCount} phase{discovery.phaseCount === 1 ? "" : "s"}
                </Badge>
                {constrainedPhases.length > 0 ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {constrainedPhases.length} constrained
                  </Badge>
                ) : null}
                {deferredPhases.length > 0 ? (
                  <Badge variant="outline" className="text-[10px]">
                    {deferredPhases.length} backlog
                  </Badge>
                ) : null}
                {discovery.failedPhaseCount > 0 ? (
                  <Badge variant="destructive" className="text-[10px]">
                    {discovery.failedPhaseCount} failed
                  </Badge>
                ) : null}
              </div>
              <div className="space-y-2">
                {discovery.phases.map((phase) => (
                  <div key={phase.key} className="rounded-md border bg-muted/20 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-medium text-foreground">{phase.label}</p>
                      <Badge
                        variant={phase.status === "failed" ? "destructive" : phase.status === "timed_out" ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {phaseStatusLabel(phase.status)}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
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
                    {phase.note ? <p className="mt-1 text-[10px] text-muted-foreground">{phase.note}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {enrichment && enrichment.phases.length > 0 ? (
            <div className="mb-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">
                  Background enrichment
                </Badge>
                <span>due {enrichment.dueTargets}</span>
                {enrichment.deferredTargets > 0 ? <span>deferred {enrichment.deferredTargets}</span> : null}
                {queuedEnrichmentPhases > 0 ? <span>queued {queuedEnrichmentPhases}</span> : null}
                {busyEnrichmentPhases > 0 ? <span>{busyEnrichmentPhases} already active</span> : null}
              </div>
              <div className="space-y-2">
                {enrichment.phases.map((phase) => (
                  <div key={phase.phase} className="rounded-md border bg-muted/20 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-medium text-foreground">
                        {discoveryEnrichmentPhaseLabel(phase.phase)}
                      </p>
                      <Badge
                        variant={phase.queued ? "default" : phase.queueBusy ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {phase.queued ? "queued" : phase.queueBusy ? "already active" : "planned"}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                      <span>wave {phase.targetCount}</span>
                      <span>due {phase.dueTargetCount}</span>
                      {phase.deferredTargetCount > 0 ? <span>deferred {phase.deferredTargetCount}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(run.details, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ACTOR_OPTIONS = [
  { value: "all", label: "All Actors" },
  { value: "steward", label: "Steward" },
  { value: "user", label: "User" },
];

const KIND_OPTIONS = [
  { value: "all", label: "All Kinds" },
  { value: "discover", label: "Discover" },
  { value: "diagnose", label: "Diagnose" },
  { value: "remediate", label: "Remediate" },
  { value: "learn", label: "Learn" },
  { value: "config", label: "Config" },
  { value: "auth", label: "Auth" },
  { value: "policy", label: "Policy" },
  { value: "playbook", label: "Playbook" },
  { value: "approval", label: "Approval" },
  { value: "digest", label: "Digest" },
];

export default function ActivityPage() {
  const { actions, scannerRuns, agentRuns, controlPlane, loading } = useSteward();

  const [actorFilter, setActorFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [actionsPage, setActionsPage] = useState(1);
  const [scannerRunsPage, setScannerRunsPage] = useState(1);
  const [agentRunsPage, setAgentRunsPage] = useState(1);
  const pageSize = 20;

  // Filter and limit actions
  const filteredActions = useMemo(() => {
    let result = [...actions];

    if (actorFilter !== "all") {
      result = result.filter((a) => a.actor === actorFilter);
    }
    if (kindFilter !== "all") {
      result = result.filter((a) => a.kind === kindFilter);
    }

    // Sort newest first
    result.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return result;
  }, [actions, actorFilter, kindFilter]);

  const sortedScannerRuns = useMemo(() => {
    return [...scannerRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [scannerRuns]);

  const sortedAgentRuns = useMemo(() => {
    return [...agentRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [agentRuns]);
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

  const actionsTotalPages = Math.max(1, Math.ceil(filteredActions.length / pageSize));
  const scannerRunsTotalPages = Math.max(1, Math.ceil(sortedScannerRuns.length / pageSize));
  const agentRunsTotalPages = Math.max(1, Math.ceil(sortedAgentRuns.length / pageSize));
  const currentActionsPage = Math.min(actionsPage, actionsTotalPages);
  const currentScannerRunsPage = Math.min(scannerRunsPage, scannerRunsTotalPages);
  const currentAgentRunsPage = Math.min(agentRunsPage, agentRunsTotalPages);
  const pagedActions = filteredActions.slice((currentActionsPage - 1) * pageSize, currentActionsPage * pageSize);
  const pagedScannerRuns = sortedScannerRuns.slice(
    (currentScannerRunsPage - 1) * pageSize,
    currentScannerRunsPage * pageSize,
  );
  const pagedAgentRuns = sortedAgentRuns.slice(
    (currentAgentRunsPage - 1) * pageSize,
    currentAgentRunsPage * pageSize,
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Audit trail of actions, scanner cycles, and operator-triggered assistant work.
        </p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="actions" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="actions">
            Action Log
            {actions.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({actions.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="scanner-runs">
            Scanner Runs
            {scannerRuns.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({scannerRuns.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="agent-runs">
            Agent Runs
            {agentRuns.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({agentRuns.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="queue-health">
            Queue Health
            {controlPlane ? (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({controlPlane.summary.pending + controlPlane.summary.processing})
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>

        {/* Action Log Tab */}
        <TabsContent value="actions" className="mt-4 min-h-0 flex-1 overflow-auto">
          <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Filter className="h-4 w-4" />
              <span>Filter:</span>
            </div>

            <Select value={actorFilter} onValueChange={(value) => {
              setActorFilter(value);
              setActionsPage(1);
            }}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTOR_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={kindFilter} onValueChange={(value) => {
              setKindFilter(value);
              setActionsPage(1);
            }}>
              <SelectTrigger className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {(actorFilter !== "all" || kindFilter !== "all") && (
              <button
                type="button"
                onClick={() => {
                  setActorFilter("all");
                  setKindFilter("all");
                  setActionsPage(1);
                }}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Action list */}
          {filteredActions.length === 0 ? (
            <Card className="bg-card/60">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {actions.length === 0
                  ? "No actions recorded yet. Run a scanner cycle to generate activity."
                  : "No actions match the current filters."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {pagedActions.map((action) => (
                <ActionEntry key={action.id} action={action} />
              ))}
            </div>
          )}
          {filteredActions.length > pageSize && (
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setActionsPage((p) => Math.max(1, p - 1))} disabled={currentActionsPage === 1}>Prev</button>
              <span className="text-xs text-muted-foreground tabular-nums">Page {currentActionsPage} / {actionsTotalPages}</span>
              <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setActionsPage((p) => Math.min(actionsTotalPages, p + 1))} disabled={currentActionsPage >= actionsTotalPages}>Next</button>
            </div>
          )}
          </div>
        </TabsContent>

        <TabsContent value="scanner-runs" className="mt-4 min-h-0 flex-1 overflow-auto">
          {sortedScannerRuns.length === 0 ? (
            <Card className="bg-card/60">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No scanner runs recorded yet. Trigger a cycle from the dashboard or settings.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
              {pagedScannerRuns.map((run) => (
                <RunEntry key={run.id} run={run} kind="scanner" fallbackLabel="Scanner cycle" />
              ))}
              </div>
              {sortedScannerRuns.length > pageSize && (
                <div className="flex items-center justify-end gap-2">
                  <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setScannerRunsPage((p) => Math.max(1, p - 1))} disabled={currentScannerRunsPage === 1}>Prev</button>
                  <span className="text-xs text-muted-foreground tabular-nums">Page {currentScannerRunsPage} / {scannerRunsTotalPages}</span>
                  <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setScannerRunsPage((p) => Math.min(scannerRunsTotalPages, p + 1))} disabled={currentScannerRunsPage >= scannerRunsTotalPages}>Next</button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agent-runs" className="mt-4 min-h-0 flex-1 overflow-auto">
          {sortedAgentRuns.length === 0 ? (
            <Card className="bg-card/60">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No agent wakes recorded yet. Agent runs now represent semantic, review, and diagnosis wakes.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
              {pagedAgentRuns.map((run) => (
                <RunEntry key={run.id} run={run} kind="agent" fallbackLabel="Agent wake" />
              ))}
              </div>
              {sortedAgentRuns.length > pageSize && (
                <div className="flex items-center justify-end gap-2">
                  <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setAgentRunsPage((p) => Math.max(1, p - 1))} disabled={currentAgentRunsPage === 1}>Prev</button>
                  <span className="text-xs text-muted-foreground tabular-nums">Page {currentAgentRunsPage} / {agentRunsTotalPages}</span>
                  <button type="button" className="rounded-md border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setAgentRunsPage((p) => Math.min(agentRunsTotalPages, p + 1))} disabled={currentAgentRunsPage >= agentRunsTotalPages}>Next</button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="queue-health" className="mt-4 min-h-0 flex-1 overflow-auto">
          {controlPlane ? (
            <div className="space-y-4">
              <Card className="bg-card/60">
                <CardContent className="grid gap-3 p-4 md:grid-cols-3">
                  <div className="rounded-md border bg-background/60 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending Jobs</p>
                    <p className="mt-1 text-lg font-semibold">{controlPlane.summary.pending}</p>
                  </div>
                  <div className="rounded-md border bg-background/60 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Processing Jobs</p>
                    <p className="mt-1 text-lg font-semibold">{controlPlane.summary.processing}</p>
                  </div>
                  <div className="rounded-md border bg-background/60 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Long-running Jobs</p>
                    <p className="mt-1 text-lg font-semibold">{controlPlane.summary.longRunningProcessing}</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div>
                    <p className="text-sm font-medium">Worker Leases</p>
                    <p className="text-xs text-muted-foreground">Current ownership and expiry for active control-plane workers.</p>
                  </div>
                  {controlPlane.leases.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No runtime leases recorded yet.</p>
                  ) : (
                    controlPlane.leases.map((lease) => {
                      return (
                        <div key={lease.name} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/60 px-3 py-2 text-xs">
                          <div className="space-y-0.5">
                            <p className="font-medium text-foreground">{lease.name}</p>
                            <p className="text-muted-foreground">{lease.holder}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                            <Badge variant="outline" className="text-[10px]">
                              lease
                            </Badge>
                            <span>Updated {relativeTime(lease.updatedAt)}</span>
                            <span>Expires {formatTimestamp(lease.expiresAt)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div>
                    <p className="text-sm font-medium">Background Discovery Enrichment</p>
                    <p className="text-xs text-muted-foreground">
                      Deep fingerprinting and hostname/browser enrichment now drain outside the core scanner loop.
                    </p>
                  </div>
                  {discoveryEnrichmentLanes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No discovery enrichment workers have queued work yet.</p>
                  ) : (
                    <>
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border bg-background/60 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending</p>
                          <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.pending}</p>
                        </div>
                        <div className="rounded-md border bg-background/60 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Processing</p>
                          <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.processing}</p>
                        </div>
                        <div className="rounded-md border bg-background/60 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Completed</p>
                          <p className="mt-1 text-lg font-semibold">{discoveryEnrichmentQueueSummary.completed}</p>
                        </div>
                      </div>
                      {discoveryEnrichmentLanes.map((lane) => (
                        <div key={lane.kind} className="rounded-md border bg-background/60 px-3 py-2 text-xs">
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
                </CardContent>
              </Card>

              <Card className="bg-card/60">
                <CardContent className="space-y-3 p-4">
                  <div>
                    <p className="text-sm font-medium">Other Queue Lanes</p>
                    <p className="text-xs text-muted-foreground">Core scanner, monitor, and agent control-plane lanes.</p>
                  </div>
                  {otherQueueLanes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No queued control-plane jobs recorded yet.</p>
                  ) : (
                    otherQueueLanes.map((lane) => (
                      <div key={lane.kind} className="rounded-md border bg-background/60 px-3 py-2 text-xs">
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
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card className="bg-card/60">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Control-plane health has not loaded yet.
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
