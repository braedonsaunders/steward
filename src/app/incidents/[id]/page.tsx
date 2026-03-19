"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  BellOff,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Loader2,
  Server,
  ShieldAlert,
  Stethoscope,
  TriangleAlert,
  Wrench,
  Info,
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSteward } from "@/lib/hooks/use-steward";
import type { Incident, IncidentSeverity } from "@/lib/state/types";
import { formatIncidentType, getIncidentType } from "@/lib/incidents/utils";
import { cn } from "@/lib/utils";

function severityBadgeVariant(
  severity: IncidentSeverity,
): "destructive" | "secondary" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "warning":
      return "secondary";
    case "info":
      return "outline";
  }
}

function statusBadgeVariant(
  status: Incident["status"],
): "default" | "destructive" | "secondary" | "outline" {
  switch (status) {
    case "open":
      return "destructive";
    case "in_progress":
      return "secondary";
    case "resolved":
      return "default";
  }
}

function severityIcon(severity: IncidentSeverity) {
  switch (severity) {
    case "critical":
      return <ShieldAlert className="size-5 text-destructive" />;
    case "warning":
      return <TriangleAlert className="size-5 text-amber-500" />;
    case "info":
      return <Info className="size-5 text-muted-foreground" />;
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>();
  const {
    incidents,
    devices,
    playbookRuns,
    loading,
    error,
    updateIncidentStatus,
    ignoreIncidentType,
    approveAction,
    denyAction,
  } = useSteward();
  const [updating, setUpdating] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{ type: "ok" | "error"; message: string } | null>(null);

  const incident = useMemo(
    () => incidents.find((i) => i.id === params.id),
    [incidents, params.id],
  );

  const affectedDevices = useMemo(() => {
    if (!incident) return [];
    return devices.filter((d) => incident.deviceIds.includes(d.id));
  }, [incident, devices]);

  const incidentPlaybookRuns = useMemo(() => {
    if (!incident) return [];
    return playbookRuns.filter((r) => r.incidentId === incident.id);
  }, [playbookRuns, incident]);

  const handleStatusChange = async (newStatus: Incident["status"]) => {
    if (!incident || updating) return;
    setUpdating(true);
    setActionFeedback(null);
    try {
      await updateIncidentStatus(incident.id, newStatus);
    } catch {
      // Error is handled by the context provider
    } finally {
      setUpdating(false);
    }
  };

  const handleIgnoreType = async () => {
    if (!incident || ignoring) return;
    const incidentTypeLabel = formatIncidentType(getIncidentType(incident));
    const shouldContinue = window.confirm(
      `Ignore future incidents of type "${incidentTypeLabel}" and resolve all open matches now?`,
    );
    if (!shouldContinue) {
      return;
    }

    setIgnoring(true);
    setActionFeedback(null);
    try {
      const result = await ignoreIncidentType(incident.id);
      setActionFeedback({
        type: "ok",
        message: `Ignored ${formatIncidentType(result.incidentType)}. Resolved ${result.resolvedCount} incident(s).`,
      });
    } catch (err) {
      setActionFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to ignore this incident type.",
      });
    } finally {
      setIgnoring(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          href="/incidents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to Incidents
        </Link>
        <Card className="border-destructive">
          <CardContent className="p-6">
            <p className="text-sm font-medium text-destructive">Error Loading Data</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="space-y-4">
        <Link
          href="/incidents"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back to Incidents
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <TriangleAlert className="size-10 text-muted-foreground/50" />
            <p className="text-sm font-medium text-muted-foreground">
              Incident not found
            </p>
            <p className="text-xs text-muted-foreground/70">
              The incident with ID &quot;{params.id}&quot; does not exist or has been removed.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/incidents">View all incidents</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/incidents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="size-4" />
        Back to Incidents
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start gap-3 flex-wrap">
          {severityIcon(incident.severity)}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold tracking-tight steward-heading-font md:text-2xl">
              {incident.title}
            </h1>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <Badge
                variant={severityBadgeVariant(incident.severity)}
                className="uppercase text-[10px]"
              >
                {incident.severity}
              </Badge>
              <Badge
                variant={statusBadgeVariant(incident.status)}
                className="capitalize text-[10px]"
              >
                {incident.status.replace("_", " ")}
              </Badge>
              {incident.autoRemediated && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-emerald-500 border-emerald-500/30"
                >
                  <Bot className="mr-1 size-3" />
                  Auto-remediated
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Detected {formatRelativeTime(incident.detectedAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Status controls */}
      <Card className="bg-card/85">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-muted-foreground">
              Update status:
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant={incident.status === "open" ? "default" : "outline"}
                size="sm"
                disabled={incident.status === "open" || updating}
                onClick={() => handleStatusChange("open")}
              >
                {updating && incident.status !== "open" ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : null}
                Open
              </Button>
              <ChevronRight className="size-4 text-muted-foreground" />
              <Button
                variant={incident.status === "in_progress" ? "default" : "outline"}
                size="sm"
                disabled={incident.status === "in_progress" || updating}
                onClick={() => handleStatusChange("in_progress")}
              >
                {updating && incident.status !== "in_progress" ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : null}
                In Progress
              </Button>
              <ChevronRight className="size-4 text-muted-foreground" />
              <Button
                variant={incident.status === "resolved" ? "default" : "outline"}
                size="sm"
                disabled={incident.status === "resolved" || updating}
                onClick={() => handleStatusChange("resolved")}
              >
                {updating && incident.status !== "resolved" ? (
                  <Loader2 className="mr-1 size-3 animate-spin" />
                ) : (
                  <Check className="mr-1 size-3" />
                )}
                Resolved
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="text-[10px]">
              Type: {formatIncidentType(getIncidentType(incident))}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              disabled={ignoring}
              onClick={() => void handleIgnoreType()}
            >
              {ignoring ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : (
                <BellOff className="mr-1 size-3" />
              )}
              Ignore Future of This Type
            </Button>
          </div>
          {actionFeedback && (
            <Alert variant={actionFeedback.type === "error" ? "destructive" : "default"}>
              <AlertDescription className="text-xs">{actionFeedback.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Summary */}
      <Card className="bg-card/85">
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {incident.summary}
          </p>
          <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
            <span>Detected: {formatDateTime(incident.detectedAt)}</span>
            <span>Updated: {formatDateTime(incident.updatedAt)}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Diagnosis */}
        {incident.diagnosis && (
          <Card className="bg-card/85">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Stethoscope className="size-4" />
                Diagnosis
              </CardTitle>
              <CardDescription>Root cause analysis</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {incident.diagnosis}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Remediation Plan */}
        {incident.remediationPlan && (
          <Card className="bg-card/85">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wrench className="size-4" />
                Remediation Plan
              </CardTitle>
              <CardDescription>Recommended steps to resolve</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                {incident.remediationPlan}
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Affected Devices */}
        <Card className="bg-card/85">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="size-4" />
              Affected Devices
              <Badge variant="secondary" className="ml-auto text-[10px] tabular-nums">
                {incident.deviceIds.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {affectedDevices.length === 0 && incident.deviceIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No devices affected.</p>
            ) : affectedDevices.length === 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Device details could not be resolved for {incident.deviceIds.length} device ID(s).
                </p>
                <ul className="space-y-1">
                  {incident.deviceIds.map((id) => (
                    <li
                      key={id}
                      className="rounded-md border bg-background/75 px-3 py-2 text-xs font-mono text-muted-foreground"
                    >
                      {id}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="space-y-2">
                {affectedDevices.map((device) => (
                  <li key={device.id}>
                    <Link
                      href={`/devices/${device.id}`}
                      className="flex items-center gap-3 rounded-md border bg-background/75 px-3 py-2 transition-colors hover:bg-muted/50"
                    >
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full shrink-0",
                          device.status === "online"
                            ? "bg-emerald-500"
                            : device.status === "offline"
                              ? "bg-red-500"
                              : device.status === "degraded"
                                ? "bg-amber-500"
                                : "bg-gray-400",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {device.name}
                        </p>
                        <p className="text-xs font-mono text-muted-foreground">
                          {device.ip}
                        </p>
                      </div>
                      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Timeline */}
        <Card className="bg-card/85">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4" />
              Timeline
              <Badge variant="secondary" className="ml-auto text-[10px] tabular-nums">
                {incident.timeline.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {incident.timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">No timeline events recorded.</p>
            ) : (
              <ScrollArea className="h-[320px] pr-4">
                <ol className="relative space-y-4 border-l border-border pl-6">
                  {incident.timeline.map((event, idx) => (
                    <li key={`${event.at}-${idx}`} className="relative">
                      <span className="absolute -left-[25px] top-1 flex size-2.5 items-center justify-center rounded-full border bg-background" />
                      <div className="space-y-1">
                        <p className="text-sm leading-snug">
                          {event.message}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(event.at)}
                          <span className="ml-2 text-muted-foreground/60">
                            ({formatRelativeTime(event.at)})
                          </span>
                        </p>
                      </div>
                      {idx < incident.timeline.length - 1 && (
                        <Separator className="mt-4" />
                      )}
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Playbook Runs */}
      {incidentPlaybookRuns.length > 0 && (
        <Card className="bg-card/85">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4" />
              Playbook Runs
              <Badge variant="secondary" className="ml-auto text-[10px] tabular-nums">
                {incidentPlaybookRuns.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {incidentPlaybookRuns.map((run) => (
                <div key={run.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{run.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.family} · Class {run.actionClass}
                      </p>
                    </div>
                    <Badge
                      variant={
                        run.status === "completed" ? "default" :
                        run.status === "failed" || run.status === "denied" ? "destructive" :
                        run.status === "pending_approval" || run.status === "waiting" ? "secondary" :
                        "outline"
                      }
                      className="shrink-0 text-[10px]"
                    >
                      {run.status.replace(/_/g, " ")}
                    </Badge>
                  </div>
                  {run.status === "pending_approval" && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => approveAction(run.id)}
                      >
                        <Check className="mr-1 size-3" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => denyAction(run.id, "Denied from incident page")}
                      >
                        Deny
                      </Button>
                      {run.expiresAt && (
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          Expires: {formatRelativeTime(run.expiresAt)}
                        </span>
                      )}
                    </div>
                  )}
                  {run.steps.length > 0 && (
                    <div className="mt-1 space-y-1">
                      {run.steps.map((step, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className={cn(
                            "size-1.5 rounded-full",
                            step.status === "passed" ? "bg-emerald-500" :
                            step.status === "failed" ? "bg-red-500" :
                            step.status === "running" ? "bg-blue-500 animate-pulse" :
                            "bg-gray-400",
                          )} />
                          <span>{step.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Metadata (if present) */}
      {Object.keys(incident.metadata).length > 0 && (
        <Card className="bg-card/85">
          <CardHeader>
            <CardTitle className="text-base">Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 sm:grid-cols-2">
              {Object.entries(incident.metadata).map(([key, value]) => (
                <div
                  key={key}
                  className="rounded-md border bg-background/75 px-3 py-2"
                >
                  <dt className="text-xs font-medium text-muted-foreground">
                    {key}
                  </dt>
                  <dd className="mt-0.5 text-sm font-mono break-all">
                    {typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
