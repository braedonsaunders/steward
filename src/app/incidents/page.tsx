"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  Filter,
  Info,
  Search,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useSteward } from "@/lib/hooks/use-steward";
import type { Incident, IncidentSeverity } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const SEVERITY_ORDER: Record<IncidentSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "resolved", label: "Resolved" },
] as const;

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

function formatTimeSince(iso: string): string {
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

function severityIcon(severity: IncidentSeverity) {
  switch (severity) {
    case "critical":
      return <ShieldAlert className="size-4 text-destructive" />;
    case "warning":
      return <TriangleAlert className="size-4 text-amber-500" />;
    case "info":
      return <Info className="size-4 text-muted-foreground" />;
  }
}

function sortIncidents(incidents: Incident[]): Incident[] {
  return [...incidents].sort((a, b) => {
    const severityCmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityCmp !== 0) return severityCmp;
    return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
  });
}

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <Link href={`/incidents/${incident.id}`}>
      <Card className="bg-card/85 transition-colors hover:bg-muted/50 cursor-pointer">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="mt-0.5 shrink-0">{severityIcon(incident.severity)}</div>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-medium leading-tight">
                    {incident.title}
                  </h3>
                  <Badge
                    variant={severityBadgeVariant(incident.severity)}
                    className="text-[10px] uppercase"
                  >
                    {incident.severity}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {incident.summary}
                </p>
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  <Badge
                    variant={statusBadgeVariant(incident.status)}
                    className="text-[10px] capitalize"
                  >
                    {incident.status.replace("_", " ")}
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <AlertTriangle className="size-3" />
                    {incident.deviceIds.length} device{incident.deviceIds.length !== 1 ? "s" : ""}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {formatTimeSince(incident.detectedAt)}
                  </span>
                  {incident.autoRemediated && (
                    <Badge variant="outline" className="text-[10px] text-emerald-500 border-emerald-500/30">
                      Auto-remediated
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function IncidentList({
  incidents,
  emptyMessage,
}: {
  incidents: Incident[];
  emptyMessage: string;
}) {
  if (incidents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <AlertTriangle className="size-10 text-muted-foreground/50" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">
            No incidents found
          </p>
          <p className="text-xs text-muted-foreground/70">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {incidents.map((incident) => (
        <IncidentCard key={incident.id} incident={incident} />
      ))}
    </div>
  );
}

export default function IncidentsPage() {
  const { incidents, loading, error } = useSteward();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityTab, setSeverityTab] = useState("all");

  const openCount = useMemo(
    () => incidents.filter((i) => i.status === "open").length,
    [incidents],
  );

  const filteredIncidents = useMemo(() => {
    let result = incidents;

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.summary.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q),
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      result = result.filter((i) => i.status === statusFilter);
    }

    // Severity filter (tab)
    if (severityTab !== "all") {
      result = result.filter((i) => i.severity === severityTab);
    }

    return sortIncidents(result);
  }, [incidents, search, statusFilter, severityTab]);

  const severityCounts = useMemo(() => {
    let source = incidents;
    if (search.trim()) {
      const q = search.toLowerCase();
      source = source.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.summary.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q),
      );
    }
    if (statusFilter !== "all") {
      source = source.filter((i) => i.status === statusFilter);
    }

    return {
      all: source.length,
      critical: source.filter((i) => i.severity === "critical").length,
      warning: source.filter((i) => i.severity === "warning").length,
      info: source.filter((i) => i.severity === "info").length,
    };
  }, [incidents, search, statusFilter]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-4 w-52" />
          </div>
        </div>
        <Skeleton className="h-10 w-full max-w-md" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-6">
          <p className="text-sm font-medium text-destructive">
            Error Loading Incidents
          </p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Incidents
            </h1>
            {openCount > 0 && (
              <Badge variant="destructive" className="tabular-nums">
                {openCount} open
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Prioritized issues that need attention
          </p>
        </div>
      </div>

      {/* Search + Status filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search incidents by title, summary, or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Filter className="size-4 text-muted-foreground shrink-0" />
          {STATUS_FILTERS.map((sf) => (
            <Button
              key={sf.value}
              variant={statusFilter === sf.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(sf.value)}
              className="text-xs"
            >
              {sf.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Severity tabs + Content */}
      <Tabs value={severityTab} onValueChange={setSeverityTab}>
        <TabsList>
          <TabsTrigger value="all">
            All
            <Badge variant="secondary" className="ml-1.5 text-[10px] tabular-nums">
              {severityCounts.all}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="critical">
            Critical
            {severityCounts.critical > 0 && (
              <Badge variant="destructive" className="ml-1.5 text-[10px] tabular-nums">
                {severityCounts.critical}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="warning">
            Warning
            {severityCounts.warning > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] tabular-nums">
                {severityCounts.warning}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="info">
            Info
            {severityCounts.info > 0 && (
              <Badge variant="outline" className="ml-1.5 text-[10px] tabular-nums">
                {severityCounts.info}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          <IncidentList
            incidents={filteredIncidents}
            emptyMessage={
              incidents.length === 0
                ? "No incidents have been detected yet. Run an agent cycle to scan for issues."
                : "Try adjusting your search or filter criteria."
            }
          />
        </TabsContent>
        <TabsContent value="critical">
          <IncidentList
            incidents={filteredIncidents}
            emptyMessage="No critical incidents match the current filters."
          />
        </TabsContent>
        <TabsContent value="warning">
          <IncidentList
            incidents={filteredIncidents}
            emptyMessage="No warning incidents match the current filters."
          />
        </TabsContent>
        <TabsContent value="info">
          <IncidentList
            incidents={filteredIncidents}
            emptyMessage="No informational incidents match the current filters."
          />
        </TabsContent>
      </Tabs>

      {/* Results count */}
      {filteredIncidents.length > 0 && filteredIncidents.length !== incidents.length && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filteredIncidents.length} of {incidents.length} incidents
        </p>
      )}
    </div>
  );
}
