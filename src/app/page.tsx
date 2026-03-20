"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Server,
  Wifi,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
  CheckSquare,
  Zap,
  Bot,
  Target,
  Newspaper,
} from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
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
import { DashboardWidgetsPanel } from "@/components/dashboard-widgets-panel";
import { countMissionTrackedSignals, listTrackedMissionInvestigations } from "@/lib/missions/tracking";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatWhen(value?: string): string {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const severityVariant = (s: string) => {
  if (s === "critical") return "destructive" as const;
  if (s === "warning") return "secondary" as const;
  return "outline" as const;
};

const priorityVariant = (p: string) => {
  if (p === "high") return "destructive" as const;
  if (p === "medium") return "secondary" as const;
  return "outline" as const;
};

interface DashboardMissionItem {
  id: string;
  title: string;
  kind: string;
  status: "active" | "paused" | "completed" | "archived";
  priority: "low" | "medium" | "high";
  nextRunAt?: string;
  lastSummary?: string;
  stateJson?: Record<string, unknown>;
  subagent?: {
    name: string;
  };
  openInvestigations: Array<{ id: string }>;
}

interface DashboardInvestigationItem {
  id: string;
  missionId?: string;
  subagentId?: string;
  parentInvestigationId?: string;
  title: string;
  status: "open" | "monitoring" | "resolved" | "closed";
  severity: "critical" | "warning" | "info";
  stage: string;
  sourceType?: string;
  sourceId?: string;
  deviceId?: string;
  updatedAt: string;
}

interface DashboardBriefingItem {
  id: string;
  title: string;
  delivered: boolean;
  createdAt: string;
}

interface DashboardAutonomyMetrics {
  workerHealth: {
    status: "healthy" | "degraded" | "offline";
    controlPlaneLeaderActive: boolean;
    pendingJobs: number;
    processingJobs: number;
    staleProcessingJobs: number;
    queueLagMs: number;
  };
  missionLatency: {
    averageMs: number;
  };
  briefingLatency: {
    averageMs: number;
  };
  channelDeliveryLatency: {
    averageMs: number;
  };
}

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState("overview");
  const [widgetToolbarSlot, setWidgetToolbarSlot] = useState<HTMLDivElement | null>(null);
  const [missions, setMissions] = useState<DashboardMissionItem[]>([]);
  const [investigations, setInvestigations] = useState<DashboardInvestigationItem[]>([]);
  const [briefings, setBriefings] = useState<DashboardBriefingItem[]>([]);
  const [metrics, setMetrics] = useState<DashboardAutonomyMetrics | null>(null);
  const [autonomyLoading, setAutonomyLoading] = useState(true);
  const {
    overview,
    incidents,
    recommendations,
    loading,
  } = useSteward();

  const openIncidents = incidents
    .filter((i) => i.status !== "resolved")
    .sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2 };
      const sa = sev[a.severity] ?? 2;
      const sb = sev[b.severity] ?? 2;
      if (sa !== sb) return sa - sb;
      return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
    })
    .slice(0, 5);

  const activeRecs = recommendations
    .filter((r) => !r.dismissed)
    .slice(0, 3);
  const healthyShare = overview.devices > 0 ? Math.round((overview.online / overview.devices) * 100) : 0;
  const topIncident = openIncidents[0];
  const activeMissionInvestigations = missions
    .filter((mission) => mission.status === "active")
    .reduce((sum, mission) => sum + countMissionTrackedSignals(mission), 0);
  const trackedInvestigations = listTrackedMissionInvestigations(
    missions.filter((mission) => mission.status === "active"),
    investigations,
  );
  const todaysBriefings = briefings.filter((briefing) => {
    const date = new Date(briefing.createdAt);
    const today = new Date();
    return date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
  });

  useEffect(() => {
    let cancelled = false;
    const loadAutonomy = async () => {
      setAutonomyLoading(true);
      try {
        const [missionResponse, investigationResponse, briefingResponse, metricsResponse] = await Promise.all([
          fetchClientJson<{ missions: DashboardMissionItem[] }>("/api/missions"),
          fetchClientJson<{ investigations: DashboardInvestigationItem[] }>("/api/investigations?status=open,monitoring"),
          fetchClientJson<{ briefings: DashboardBriefingItem[] }>("/api/briefings"),
          fetchClientJson<DashboardAutonomyMetrics>("/api/autonomy/metrics"),
        ]);
        if (cancelled) {
          return;
        }
        setMissions(missionResponse.missions);
        setInvestigations(investigationResponse.investigations);
        setBriefings(briefingResponse.briefings);
        setMetrics(metricsResponse);
      } catch {
        if (!cancelled) {
          setMissions([]);
          setInvestigations([]);
          setBriefings([]);
          setMetrics(null);
        }
      } finally {
        if (!cancelled) {
          setAutonomyLoading(false);
        }
      }
    };

    void loadAutonomy();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && autonomyLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-8 w-16 rounded bg-muted" />
                <div className="mt-2 h-4 w-24 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="steward-kicker">Operations</p>
          <h1 className="steward-heading-font mt-1 text-[2rem] font-semibold text-foreground md:text-[2.25rem]">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mission control for Steward as your always-on IT operator.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3 xl:w-[34rem]">
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="steward-kicker">Availability</p>
            <p className="mt-1 text-lg font-semibold text-foreground">{healthyShare}% online</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="steward-kicker">Incidents</p>
            <p className="mt-1 text-lg font-semibold text-foreground">{overview.incidents} active</p>
          </div>
          <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <p className="steward-kicker">Top Priority</p>
            <p className="mt-1 truncate text-sm font-medium text-foreground">
              {topIncident ? topIncident.title : "No unresolved incidents"}
            </p>
          </div>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="widgets">Widgets</TabsTrigger>
          </TabsList>
          <div ref={setWidgetToolbarSlot} className="ml-auto flex flex-wrap items-center justify-end gap-2" />
        </div>

        <TabsContent value="overview" className="mt-4 min-h-0 flex-1 overflow-auto">
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Target className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="steward-kicker">Active Missions</p>
                    <p className="mt-1 text-2xl font-semibold">{missions.filter((mission) => mission.status === "active").length}</p>
                    <p className="text-xs text-muted-foreground">Durable responsibilities</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/10">
                    <Bot className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div>
                    <p className="steward-kicker">Investigations</p>
                    <p className="mt-1 text-2xl font-semibold">{activeMissionInvestigations}</p>
                    <p className="text-xs text-muted-foreground">Open or monitoring</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    overview.pendingApprovals > 0 ? "bg-orange-500/10" : "bg-muted",
                  )}>
                    <CheckSquare className={cn(
                      "h-5 w-5",
                      overview.pendingApprovals > 0 ? "text-orange-600 dark:text-orange-400" : "text-muted-foreground",
                    )} />
                  </div>
                  <div>
                    <p className="steward-kicker">Pending Approvals</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.pendingApprovals}</p>
                    <p className="text-xs text-muted-foreground">Human decisions waiting</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/10">
                    <Newspaper className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
                  </div>
                  <div>
                    <p className="steward-kicker">Today&apos;s Briefings</p>
                    <p className="mt-1 text-2xl font-semibold">{todaysBriefings.length}</p>
                    <p className="text-xs text-muted-foreground">Operator updates delivered or staged</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {metrics ? (
              <div className="grid gap-3 lg:grid-cols-4">
                <div className="rounded-lg border border-border bg-card px-3 py-3">
                  <p className="steward-kicker">Autonomy Worker</p>
                  <p className="mt-1 text-sm font-semibold capitalize text-foreground">{metrics.workerHealth.status}</p>
                  <p className="text-xs text-muted-foreground">
                    {metrics.workerHealth.controlPlaneLeaderActive ? "Leader active" : "Leader offline"}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-card px-3 py-3">
                  <p className="steward-kicker">Queue Lag</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{Math.round(metrics.workerHealth.queueLagMs / 1000)}s</p>
                  <p className="text-xs text-muted-foreground">
                    {metrics.workerHealth.pendingJobs} pending, {metrics.workerHealth.processingJobs} processing
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-card px-3 py-3">
                  <p className="steward-kicker">Mission Latency</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{Math.round(metrics.missionLatency.averageMs / 1000)}s avg</p>
                  <p className="text-xs text-muted-foreground">Runtime completion over last 24h</p>
                </div>
                <div className="rounded-lg border border-border bg-card px-3 py-3">
                  <p className="steward-kicker">Delivery Latency</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{Math.round(metrics.channelDeliveryLatency.averageMs / 1000)}s avg</p>
                  <p className="text-xs text-muted-foreground">Gateway delivery timing over last 24h</p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-base">Mission Control</CardTitle>
                    <CardDescription>What Steward currently owns</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/missions">
                      View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {missions.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No missions in scope.</p> : <div className="space-y-3">{missions.slice(0, 5).map((mission) => (
                    <Link key={mission.id} href="/missions" className="block rounded-lg border p-3 transition-colors hover:bg-muted/50">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{mission.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                            {mission.subagent?.name ?? "Unassigned"} | {countMissionTrackedSignals(mission)} item(s) in flight
                          </p>
                        </div>
                        <Badge variant={priorityVariant(mission.priority)} className="shrink-0">{mission.priority}</Badge>
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">{mission.lastSummary ?? `Next run ${formatWhen(mission.nextRunAt)}`}</p>
                    </Link>
                  ))}</div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-base">Active Investigations</CardTitle>
                    <CardDescription>Ambiguous work that remains in flight</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/missions">
                      Open missions <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {trackedInvestigations.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No active investigations.</p> : <div className="space-y-3">{trackedInvestigations.slice(0, 5).map((investigation) => (
                    <div key={investigation.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{investigation.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">Stage {investigation.stage} · {relativeTime(investigation.updatedAt)}</p>
                        </div>
                        <Badge variant={severityVariant(investigation.severity)} className="shrink-0">{investigation.severity}</Badge>
                      </div>
                    </div>
                  ))}</div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-base">Recent Briefings</CardTitle>
                    <CardDescription>Telegram-first operator updates</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/gateway">
                      Gateway <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {briefings.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No briefings yet.</p> : <div className="space-y-3">{briefings.slice(0, 5).map((briefing) => (
                    <div key={briefing.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{briefing.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{relativeTime(briefing.createdAt)}</p>
                        </div>
                        <Badge variant={briefing.delivered ? "default" : "outline"} className="shrink-0">
                          {briefing.delivered ? "Delivered" : "Stored"}
                        </Badge>
                      </div>
                    </div>
                  ))}</div>}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Server className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="steward-kicker">Inventory</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.devices}</p>
                    <p className="text-xs text-muted-foreground">Total devices</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                    <Wifi className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="steward-kicker">Reachable</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.online}</p>
                    <p className="text-xs text-muted-foreground">Online</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    overview.incidents > 0 ? "bg-destructive/10" : "bg-muted",
                  )}>
                    <AlertTriangle className={cn(
                      "h-5 w-5",
                      overview.incidents > 0 ? "text-destructive" : "text-muted-foreground",
                    )} />
                  </div>
                  <div>
                    <p className="steward-kicker">Incidents</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.incidents}</p>
                    <p className="text-xs text-muted-foreground">Open incidents</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                    <Lightbulb className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div>
                    <p className="steward-kicker">Suggestions</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.recommendations}</p>
                    <p className="text-xs text-muted-foreground">Recommendations</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    overview.pendingApprovals > 0 ? "bg-orange-500/10" : "bg-muted",
                  )}>
                    <CheckSquare className={cn(
                      "h-5 w-5",
                      overview.pendingApprovals > 0 ? "text-orange-600 dark:text-orange-400" : "text-muted-foreground",
                    )} />
                  </div>
                  <div>
                    <p className="steward-kicker">Queue</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.pendingApprovals}</p>
                    <p className="text-xs text-muted-foreground">Pending approvals</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/10">
                    <Zap className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
                  </div>
                  <div>
                    <p className="steward-kicker">Execution</p>
                    <p className="mt-1 text-2xl font-semibold">{overview.playbooksRunning}</p>
                    <p className="text-xs text-muted-foreground">Playbooks running</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-base">Recent Incidents</CardTitle>
                    <CardDescription>Issues that need attention</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/incidents">
                      View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {openIncidents.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No open incidents. All clear.</p> : <div className="space-y-3">{openIncidents.map((incident) => (
                    <Link key={incident.id} href={`/incidents/${incident.id}`} className="block rounded-lg border p-3 transition-colors hover:bg-muted/50">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{incident.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{incident.summary}</p>
                        </div>
                        <Badge variant={severityVariant(incident.severity)} className="shrink-0">{incident.severity}</Badge>
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">{relativeTime(incident.detectedAt)} · {incident.deviceIds.length} device{incident.deviceIds.length !== 1 ? "s" : ""}</p>
                    </Link>
                  ))}</div>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <div>
                    <CardTitle className="text-base">Top Recommendations</CardTitle>
                    <CardDescription>Suggested improvements</CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/incidents">
                      View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {activeRecs.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No active recommendations.</p> : <div className="space-y-3">{activeRecs.map((rec) => (
                    <div key={rec.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{rec.title}</p>
                        <Badge variant={priorityVariant(rec.priority)} className="shrink-0">{rec.priority}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{rec.rationale}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">{rec.impact}</p>
                    </div>
                  ))}</div>}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="widgets" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <DashboardWidgetsPanel
            active={activeTab === "widgets"}
            toolbarSlot={widgetToolbarSlot}
            className="h-full"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
