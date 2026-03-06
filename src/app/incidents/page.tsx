"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BellOff,
  Check,
  Filter,
  Info,
  Loader2,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSteward } from "@/lib/hooks/use-steward";
import type { Incident, IncidentSeverity } from "@/lib/state/types";
import { formatIncidentType, getIncidentType } from "@/lib/incidents/utils";

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

function IncidentTable({
  incidents,
  emptyMessage,
  actionBusy,
  onResolve,
  onIgnoreType,
}: {
  incidents: Incident[];
  emptyMessage: string;
  actionBusy: { id: string; kind: "resolve" | "ignore" } | null;
  onResolve: (incident: Incident) => Promise<void>;
  onIgnoreType: (incident: Incident) => Promise<void>;
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
    <div className="min-h-0 overflow-auto rounded-lg border bg-card/85">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Severity</TableHead>
            <TableHead>Incident</TableHead>
            <TableHead className="w-[120px]">Status</TableHead>
            <TableHead className="w-[90px]">Devices</TableHead>
            <TableHead className="w-[110px]">Detected</TableHead>
            <TableHead className="hidden w-[130px] md:table-cell">Remediation</TableHead>
            <TableHead className="w-[180px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {incidents.map((incident) => (
            <TableRow key={incident.id} className="h-12">
              <TableCell>
                <Badge
                  variant={severityBadgeVariant(incident.severity)}
                  className="inline-flex items-center gap-1 text-[10px] uppercase"
                >
                  {severityIcon(incident.severity)}
                  {incident.severity}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="min-w-0">
                  <Link
                    href={`/incidents/${incident.id}`}
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {incident.title}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{incident.summary}</p>
                </div>
              </TableCell>
              <TableCell>
                <Badge
                  variant={statusBadgeVariant(incident.status)}
                  className="text-[10px] capitalize"
                >
                  {incident.status.replace("_", " ")}
                </Badge>
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {incident.deviceIds.length}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatTimeSince(incident.detectedAt)}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {incident.autoRemediated ? (
                  <Badge variant="outline" className="border-emerald-500/30 text-[10px] text-emerald-500">
                    Auto-remediated
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Manual</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      incident.status === "resolved"
                      || (actionBusy?.id === incident.id && actionBusy.kind === "resolve")
                    }
                    onClick={() => void onResolve(incident)}
                  >
                    {actionBusy?.id === incident.id && actionBusy.kind === "resolve" ? (
                      <Loader2 className="mr-1 size-3 animate-spin" />
                    ) : (
                      <Check className="mr-1 size-3" />
                    )}
                    Resolve
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={actionBusy?.id === incident.id && actionBusy.kind === "ignore"}
                    title={`Ignore future incidents for type: ${formatIncidentType(getIncidentType(incident))}`}
                    onClick={() => void onIgnoreType(incident)}
                  >
                    {actionBusy?.id === incident.id && actionBusy.kind === "ignore" ? (
                      <Loader2 className="mr-1 size-3 animate-spin" />
                    ) : (
                      <BellOff className="mr-1 size-3" />
                    )}
                    Ignore Type
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function IncidentsPage() {
  const {
    incidents,
    loading,
    error,
    updateIncidentStatus,
    ignoreIncidentType,
  } = useSteward();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [severityTab, setSeverityTab] = useState("all");
  const [page, setPage] = useState(1);
  const [actionBusy, setActionBusy] = useState<{ id: string; kind: "resolve" | "ignore" } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pageSize = 12;

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

  const totalPages = Math.max(1, Math.ceil(filteredIncidents.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedIncidents = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredIncidents.slice(start, start + pageSize);
  }, [filteredIncidents, currentPage]);

  const handleResolve = useCallback(async (incident: Incident) => {
    setActionBusy({ id: incident.id, kind: "resolve" });
    setActionError(null);
    try {
      await updateIncidentStatus(incident.id, "resolved");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to resolve incident.");
    } finally {
      setActionBusy(null);
    }
  }, [updateIncidentStatus]);

  const handleIgnoreType = useCallback(async (incident: Incident) => {
    const incidentType = formatIncidentType(getIncidentType(incident));
    const shouldContinue = window.confirm(
      `Ignore future incidents of type "${incidentType}" and resolve current open matches?`,
    );
    if (!shouldContinue) {
      return;
    }

    setActionBusy({ id: incident.id, kind: "ignore" });
    setActionError(null);
    try {
      await ignoreIncidentType(incident.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to ignore incident type.");
    } finally {
      setActionBusy(null);
    }
  }, [ignoreIncidentType]);

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
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight steward-heading-font md:text-3xl">
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

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{actionError}</AlertDescription>
        </Alert>
      )}

      {/* Search + Status filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search incidents by title, summary, or ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
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
              onClick={() => {
                setStatusFilter(sf.value);
                setPage(1);
              }}
              className="text-xs"
            >
              {sf.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Severity tabs + Content */}
      <Tabs value={severityTab} onValueChange={(value) => {
        setSeverityTab(value);
        setPage(1);
      }} className="flex min-h-0 flex-1 flex-col">
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

        <TabsContent value="all" className="mt-4 min-h-0 flex-1 overflow-auto">
          <IncidentTable
            incidents={pagedIncidents}
            emptyMessage={
              incidents.length === 0
                ? "No incidents have been detected yet. Run an agent cycle to scan for issues."
                : "Try adjusting your search or filter criteria."
            }
            actionBusy={actionBusy}
            onResolve={handleResolve}
            onIgnoreType={handleIgnoreType}
          />
        </TabsContent>
        <TabsContent value="critical" className="mt-4 min-h-0 flex-1 overflow-auto">
          <IncidentTable
            incidents={pagedIncidents}
            emptyMessage="No critical incidents match the current filters."
            actionBusy={actionBusy}
            onResolve={handleResolve}
            onIgnoreType={handleIgnoreType}
          />
        </TabsContent>
        <TabsContent value="warning" className="mt-4 min-h-0 flex-1 overflow-auto">
          <IncidentTable
            incidents={pagedIncidents}
            emptyMessage="No warning incidents match the current filters."
            actionBusy={actionBusy}
            onResolve={handleResolve}
            onIgnoreType={handleIgnoreType}
          />
        </TabsContent>
        <TabsContent value="info" className="mt-4 min-h-0 flex-1 overflow-auto">
          <IncidentTable
            incidents={pagedIncidents}
            emptyMessage="No informational incidents match the current filters."
            actionBusy={actionBusy}
            onResolve={handleResolve}
            onIgnoreType={handleIgnoreType}
          />
        </TabsContent>
      </Tabs>

      {filteredIncidents.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <p>
            Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filteredIncidents.length)} of {filteredIncidents.length}
            {filteredIncidents.length !== incidents.length ? ` filtered from ${incidents.length}` : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              Prev
            </Button>
            <span className="tabular-nums">Page {currentPage} / {totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
