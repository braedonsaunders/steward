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
import type { ActionLog, AgentRunRecord } from "@/lib/state/types";

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
// Agent Run Entry
// ---------------------------------------------------------------------------

function AgentRunEntry({ run }: { run: AgentRunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(run.details).length > 0;
  const isRunning = !run.completedAt;

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
            <p className="text-sm font-medium leading-snug">{run.summary || "Agent cycle"}</p>
            <Badge variant={run.outcome === "ok" ? "default" : "destructive"} className="text-[10px]">
              {run.outcome}
            </Badge>
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
        </div>
      </button>

      {/* Expandable details */}
      {expanded && hasDetails && (
        <div className="border-t px-4 py-3">
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
];

export default function ActivityPage() {
  const { actions, agentRuns, loading } = useSteward();

  const [actorFilter, setActorFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");

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

    return result.slice(0, 200);
  }, [actions, actorFilter, kindFilter]);

  // Sort agent runs newest first
  const sortedRuns = useMemo(() => {
    return [...agentRuns].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [agentRuns]);

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
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Audit trail of actions and agent cycle history.
        </p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="actions" className="space-y-4">
        <TabsList>
          <TabsTrigger value="actions">
            Action Log
            {actions.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({actions.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="runs">
            Agent Runs
            {agentRuns.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                ({agentRuns.length})
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Action Log Tab */}
        <TabsContent value="actions" className="space-y-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Filter className="h-4 w-4" />
              <span>Filter:</span>
            </div>

            <Select value={actorFilter} onValueChange={setActorFilter}>
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

            <Select value={kindFilter} onValueChange={setKindFilter}>
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
                  ? "No actions recorded yet. Run an agent cycle to generate activity."
                  : "No actions match the current filters."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {filteredActions.map((action) => (
                <ActionEntry key={action.id} action={action} />
              ))}
              {filteredActions.length >= 200 && (
                <p className="pt-2 text-center text-xs text-muted-foreground">
                  Showing the most recent 200 entries.
                </p>
              )}
            </div>
          )}
        </TabsContent>

        {/* Agent Runs Tab */}
        <TabsContent value="runs" className="space-y-4">
          {sortedRuns.length === 0 ? (
            <Card className="bg-card/60">
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No agent runs recorded yet. Trigger a cycle from the dashboard or settings.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {sortedRuns.map((run) => (
                <AgentRunEntry key={run.id} run={run} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
