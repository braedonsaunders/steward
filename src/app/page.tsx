"use client";

import Link from "next/link";
import {
  Server,
  Wifi,
  AlertTriangle,
  Lightbulb,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  CheckSquare,
  Zap,
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

export default function DashboardPage() {
  const {
    overview,
    incidents,
    recommendations,
    agentRuns,
    pendingApprovals,
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

  const lastRun = agentRuns[0];

  if (loading) {
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight steward-heading-font">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Network operations overview
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{overview.devices}</p>
              <p className="text-xs text-muted-foreground">Total Devices</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <Wifi className="h-5 w-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{overview.online}</p>
              <p className="text-xs text-muted-foreground">Online</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
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
              <p className="text-2xl font-semibold">{overview.incidents}</p>
              <p className="text-xs text-muted-foreground">Open Incidents</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
              <Lightbulb className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{overview.recommendations}</p>
              <p className="text-xs text-muted-foreground">Recommendations</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
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
              <p className="text-2xl font-semibold">{overview.pendingApprovals}</p>
              <p className="text-xs text-muted-foreground">Pending Approvals</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/10">
              <Zap className="h-5 w-5 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div>
              <p className="text-2xl font-semibold">{overview.playbooksRunning}</p>
              <p className="text-xs text-muted-foreground">Playbooks Running</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 min-h-0 flex-1 overflow-auto">
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
        </TabsContent>

        <TabsContent value="operations" className="mt-4 min-h-0 flex-1 overflow-auto">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <div>
                  <CardTitle className="text-base">Pending Approvals</CardTitle>
                  <CardDescription>Actions awaiting your review</CardDescription>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/approvals">
                    View all <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Link>
                </Button>
              </CardHeader>
              <CardContent>
                {pendingApprovals.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No pending approvals. All clear.</p> : <div className="space-y-3">{pendingApprovals.slice(0, 5).map((approval) => (
                  <Link key={approval.id} href="/approvals" className="block rounded-lg border p-3 transition-colors hover:bg-muted/50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{approval.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">Device: {approval.deviceId}</p>
                      </div>
                      <Badge variant="secondary" className="shrink-0">{approval.actionClass}</Badge>
                    </div>
                    {approval.expiresAt && <p className="mt-2 text-[11px] text-muted-foreground">Expires: {new Date(approval.expiresAt).toLocaleString()}</p>}
                  </Link>
                ))}</div>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Agent Status</CardTitle>
                <CardDescription>Last agent cycle execution</CardDescription>
              </CardHeader>
              <CardContent>
                {lastRun ? (
                  <div className="flex items-center gap-4">
                    <div className={cn("flex h-10 w-10 items-center justify-center rounded-full", lastRun.outcome === "ok" ? "bg-green-500/10" : "bg-destructive/10")}>
                      {lastRun.outcome === "ok" ? <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" /> : <XCircle className="h-5 w-5 text-destructive" />}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{lastRun.outcome === "ok" ? "Cycle completed successfully" : "Cycle failed"}</p>
                      <p className="text-xs text-muted-foreground">{lastRun.summary}</p>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {relativeTime(lastRun.startedAt)}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No agent cycles have run yet. Click &quot;Run Cycle&quot; to start.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
