"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock,
  Globe,
  Lightbulb,
  Lock,
  Network,
  Server,
  Shield,
  Unlock,
  Wifi,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSteward } from "@/lib/hooks/use-steward";
import { getDeviceAdoptionStatus, type DeviceAdoptionStatus } from "@/lib/state/device-adoption";
import type { DeviceStatus, IncidentSeverity, RecommendationPriority } from "@/lib/state/types";
import { cn } from "@/lib/utils";

function statusDotColor(status: DeviceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "offline":
      return "bg-red-500";
    case "degraded":
      return "bg-amber-500";
    default:
      return "bg-gray-400";
  }
}

function statusBadgeVariant(
  status: DeviceStatus,
): "default" | "destructive" | "secondary" | "outline" {
  switch (status) {
    case "online":
      return "default";
    case "offline":
      return "destructive";
    case "degraded":
      return "secondary";
    default:
      return "outline";
  }
}

function incidentBadgeVariant(
  severity: IncidentSeverity,
): "default" | "destructive" | "secondary" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "warning":
      return "secondary";
    default:
      return "outline";
  }
}

function recommendationBadgeVariant(
  priority: RecommendationPriority,
): "default" | "destructive" | "secondary" | "outline" {
  switch (priority) {
    case "high":
      return "destructive";
    case "medium":
      return "secondary";
    default:
      return "outline";
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const {
    devices,
    baselines,
    incidents,
    recommendations,
    playbookRuns,
    graphEdges,
    graphNodes,
    setDeviceAdoptionStatus,
    loading,
    error,
  } = useSteward();
  const [adoptionSaving, setAdoptionSaving] = useState(false);

  const device = useMemo(
    () => devices.find((d) => d.id === deviceId),
    [devices, deviceId],
  );

  const baseline = useMemo(
    () => baselines.find((b) => b.deviceId === deviceId),
    [baselines, deviceId],
  );

  const relatedIncidents = useMemo(
    () => incidents.filter((i) => i.deviceIds.includes(deviceId)),
    [incidents, deviceId],
  );

  const relatedRecommendations = useMemo(
    () => recommendations.filter((r) => r.relatedDeviceIds.includes(deviceId)),
    [recommendations, deviceId],
  );

  const devicePlaybookRuns = useMemo(
    () => playbookRuns.filter((r) => r.deviceId === deviceId),
    [playbookRuns, deviceId],
  );

  const relatedEdges = useMemo(() => {
    const nodeId = `device:${deviceId}`;
    return graphEdges.filter((e) => e.from === nodeId || e.to === nodeId);
  }, [graphEdges, deviceId]);

  const nodeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graphNodes) {
      map.set(node.id, node.label);
    }
    return map;
  }, [graphNodes]);

  if (loading) {
    return (
      <main className="space-y-6">
        <Skeleton className="h-5 w-24" />
        <div className="space-y-3">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </main>
    );
  }

  if (error) {
    return (
      <main>
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  if (!device) {
    return (
      <main>
        <Button variant="ghost" size="sm" asChild className="mb-4">
          <Link href="/devices">
            <ArrowLeft className="mr-2 size-4" />
            Back to Devices
          </Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Server className="size-10 text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">
                Device not found
              </p>
              <p className="text-xs text-muted-foreground/70">
                The device with ID &ldquo;{deviceId}&rdquo; does not exist or
                has been removed.
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/devices">View all devices</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);

  const updateAdoption = async (status: DeviceAdoptionStatus) => {
    setAdoptionSaving(true);
    try {
      await setDeviceAdoptionStatus(device.id, status);
    } finally {
      setAdoptionSaving(false);
    }
  };

  return (
    <main className="flex h-full min-h-0 flex-col gap-4">
      {/* Back link */}
      <Button variant="ghost" size="sm" asChild>
        <Link href="/devices">
          <ArrowLeft className="mr-2 size-4" />
          Back to Devices
        </Link>
      </Button>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      {/* Device Header */}
      <section className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "inline-block size-3 rounded-full",
                  statusDotColor(device.status),
                )}
              />
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                {device.name}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusBadgeVariant(device.status)} className="capitalize">
                {device.status}
              </Badge>
              <Badge variant="outline" className="capitalize">
                {device.type.replace(/-/g, " ")}
              </Badge>
              <Badge variant="secondary">
                <Shield className="mr-1 size-3" />
                Tier {device.autonomyTier}
              </Badge>
              <Badge variant={adoptionStatus === "adopted" ? "default" : adoptionStatus === "ignored" ? "outline" : "secondary"}>
                {adoptionStatus === "adopted" ? "Adopted" : adoptionStatus === "ignored" ? "Ignored" : "Discovered"}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant={adoptionStatus === "adopted" ? "default" : "outline"}
                disabled={adoptionSaving}
                onClick={() => void updateAdoption("adopted")}
              >
                Adopt For Management
              </Button>
              <Button
                type="button"
                size="sm"
                variant={adoptionStatus === "discovered" ? "secondary" : "outline"}
                disabled={adoptionSaving}
                onClick={() => void updateAdoption("discovered")}
              >
                Keep As Discovered
              </Button>
              <Button
                type="button"
                size="sm"
                variant={adoptionStatus === "ignored" ? "secondary" : "outline"}
                disabled={adoptionSaving}
                onClick={() => void updateAdoption("ignored")}
              >
                Ignore Device
              </Button>
            </div>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <p>First seen: {formatDate(device.firstSeenAt)}</p>
            <p>Last seen: {formatRelative(device.lastSeenAt)}</p>
          </div>
        </div>

      </section>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
          <TabsTrigger value="incidents">Incidents</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 gap-4 lg:grid-cols-2">
            <Card className="min-h-0 overflow-hidden bg-card/85 lg:row-span-2">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Server className="size-4 text-muted-foreground" />
                  <CardTitle className="text-base">Device Metadata</CardTitle>
                </div>
                <CardDescription>
                  Identity and discovery properties
                </CardDescription>
              </CardHeader>
              <CardContent className="h-full overflow-auto">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">IP Address</p>
                    <p className="font-mono text-sm">{device.ip}</p>
                  </div>
                  {device.mac && <div className="space-y-1"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">MAC Address</p><p className="font-mono text-sm">{device.mac}</p></div>}
                  {device.hostname && <div className="space-y-1"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Hostname</p><p className="text-sm">{device.hostname}</p></div>}
                  {device.vendor && <div className="space-y-1"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Vendor</p><p className="text-sm">{device.vendor}</p></div>}
                  {device.os && <div className="space-y-1"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Operating System</p><p className="text-sm">{device.os}</p></div>}
                  {device.role && <div className="space-y-1"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Role</p><p className="text-sm">{device.role}</p></div>}
                  {device.protocols.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Protocols</p>
                      <div className="flex flex-wrap gap-1">
                        {device.protocols.map((p) => (
                          <Badge key={p} variant="outline" className="text-[10px]">{p}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {device.tags.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tags</p>
                      <div className="flex flex-wrap gap-1">
                        {device.tags.map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0 bg-card/85">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" />
                  <CardTitle className="text-base">Latency Baseline</CardTitle>
                </div>
                <CardDescription>
                  Network performance metrics
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!baseline ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Activity className="size-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No baseline data available</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="rounded-md border bg-background/50 p-3 text-center"><p className="text-lg font-semibold tabular-nums">{baseline.avgLatencyMs.toFixed(1)}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Avg (ms)</p></div>
                      <div className="rounded-md border bg-background/50 p-3 text-center"><p className="text-lg font-semibold tabular-nums">{baseline.minLatencyMs.toFixed(1)}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Min (ms)</p></div>
                      <div className="rounded-md border bg-background/50 p-3 text-center"><p className="text-lg font-semibold tabular-nums">{baseline.maxLatencyMs.toFixed(1)}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Max (ms)</p></div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Samples: {baseline.samples}</span>
                      <span>Updated: {formatRelative(baseline.lastUpdatedAt)}</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="min-h-0 overflow-hidden bg-card/85">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Lightbulb className="size-4 text-muted-foreground" />
                  <CardTitle className="text-base">Recommendations</CardTitle>
                  {relatedRecommendations.length > 0 && (
                    <Badge variant="secondary" className="ml-auto tabular-nums">
                      {relatedRecommendations.length}
                    </Badge>
                  )}
                </div>
                <CardDescription>
                  Suggested improvements for this device
                </CardDescription>
              </CardHeader>
              <CardContent className="min-h-0">
                {relatedRecommendations.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Lightbulb className="size-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      No recommendations for this device
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2 max-h-[32dvh] overflow-auto pr-1">
                    {relatedRecommendations.map((rec) => (
                      <li
                        key={rec.id}
                        className={cn(
                          "rounded-md border bg-background/75 p-3 space-y-1.5",
                          rec.dismissed && "opacity-60",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium">{rec.title}</p>
                          <Badge
                            variant={recommendationBadgeVariant(rec.priority)}
                            className="shrink-0 text-[10px] uppercase"
                          >
                            {rec.priority}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {rec.rationale}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70">
                          Impact: {rec.impact}
                        </p>
                        {rec.dismissed && (
                          <Badge
                            variant="outline"
                            className="text-[9px] px-1.5 py-0"
                          >
                            Dismissed
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="services" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">Services</CardTitle>
                <Badge variant="secondary" className="ml-auto tabular-nums">{device.services.length}</Badge>
              </div>
              <CardDescription>Active services discovered on this device</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              {device.services.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Wifi className="size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No services discovered yet</p>
                </div>
              ) : (
                <div className="h-full overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Port</TableHead><TableHead>Transport</TableHead><TableHead>Service</TableHead><TableHead>Product</TableHead><TableHead>Version</TableHead><TableHead>Secure</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {device.services.map((svc) => (
                        <TableRow key={svc.id}>
                          <TableCell className="font-mono text-sm tabular-nums">{svc.port}</TableCell>
                          <TableCell className="uppercase text-xs">{svc.transport}</TableCell>
                          <TableCell className="font-medium">{svc.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{svc.product ?? "-"}</TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">{svc.version ?? "-"}</TableCell>
                          <TableCell>{svc.secure ? <div className="flex items-center gap-1 text-emerald-600"><Lock className="size-3.5" /><span className="text-xs">Yes</span></div> : <div className="flex items-center gap-1 text-amber-600"><Unlock className="size-3.5" /><span className="text-xs">No</span></div>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="dependencies" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Network className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">Graph Dependencies</CardTitle>
                {relatedEdges.length > 0 && <Badge variant="secondary" className="ml-auto tabular-nums">{relatedEdges.length}</Badge>}
              </div>
              <CardDescription>Knowledge graph edges involving this device</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              {relatedEdges.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center"><Network className="size-8 text-muted-foreground/40" /><p className="text-sm text-muted-foreground">No graph connections found</p></div>
              ) : (
                <div className="h-full overflow-auto rounded-md border">
                  <Table>
                    <TableHeader><TableRow><TableHead>From</TableHead><TableHead>Relationship</TableHead><TableHead>To</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {relatedEdges.map((edge) => (
                        <TableRow key={edge.id}>
                          <TableCell className="text-sm">{edge.from === `device:${deviceId}` ? <Badge variant="default" className="text-[10px]">This device</Badge> : <span className="text-muted-foreground">{nodeLabels.get(edge.from) ?? edge.from}</span>}</TableCell>
                          <TableCell><div className="flex items-center gap-1.5"><ChevronRight className="size-3 text-muted-foreground" /><Badge variant="outline" className="text-[10px] capitalize">{edge.type.replace(/_/g, " ")}</Badge><ChevronRight className="size-3 text-muted-foreground" /></div></TableCell>
                          <TableCell className="text-sm">{edge.to === `device:${deviceId}` ? <Badge variant="default" className="text-[10px]">This device</Badge> : <span className="text-muted-foreground">{nodeLabels.get(edge.to) ?? edge.to}</span>}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatRelative(edge.updatedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="incidents" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div className="h-full min-h-0">
            <div className="grid h-full min-h-0 gap-4">
        {/* Related Incidents */}
        <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Related Incidents</CardTitle>
              {relatedIncidents.length > 0 && (
                <Badge variant="secondary" className="ml-auto tabular-nums">
                  {relatedIncidents.length}
                </Badge>
              )}
            </div>
            <CardDescription>
              Incidents involving this device
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            {relatedIncidents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <AlertTriangle className="size-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No incidents for this device
                </p>
              </div>
            ) : (
              <ul className="h-full space-y-2 overflow-auto pr-1">
                {relatedIncidents.map((incident) => (
                  <li
                    key={incident.id}
                    className="rounded-md border bg-background/75 p-3 space-y-1.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium">{incident.title}</p>
                      <Badge
                        variant={incidentBadgeVariant(incident.severity)}
                        className="shrink-0 text-[10px] uppercase"
                      >
                        {incident.severity}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {incident.summary}
                    </p>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
                      <span className="capitalize">
                        Status: {incident.status.replace("_", " ")}
                      </span>
                      <span>
                        <Clock className="mr-0.5 inline size-3" />
                        {formatRelative(incident.updatedAt)}
                      </span>
                      {incident.autoRemediated && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1.5 py-0"
                        >
                          Auto-remediated
                        </Badge>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>

          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">Playbook History</CardTitle>
                {devicePlaybookRuns.length > 0 && <Badge variant="secondary" className="ml-auto tabular-nums">{devicePlaybookRuns.length}</Badge>}
              </div>
              <CardDescription>Playbook executions targeting this device</CardDescription>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">
              {devicePlaybookRuns.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center"><Wrench className="size-8 text-muted-foreground/40" /><p className="text-sm text-muted-foreground">No playbook runs for this device</p></div>
              ) : (
                <ul className="h-full space-y-2 overflow-auto pr-1">
                  {devicePlaybookRuns.map((run) => (
                    <li key={run.id} className="rounded-md border bg-background/75 p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{run.name}</p>
                        <Badge
                          variant={
                            run.status === "completed" ? "default" :
                            run.status === "failed" || run.status === "denied" ? "destructive" :
                            run.status === "pending_approval" ? "secondary" :
                            "outline"
                          }
                          className="shrink-0 text-[10px]"
                        >
                          {run.status.replace(/_/g, " ")}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{run.family} · Class {run.actionClass}</p>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70"><span><Clock className="mr-0.5 inline size-3" />{formatRelative(run.createdAt)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      </div>
    </main>
  );
}
