"use client";

import { type FormEvent, type MouseEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Loader2,
  Monitor,
  Network,
  Play,
  Plus,
  Search,
  Server,
  Shield,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSteward } from "@/lib/hooks/use-steward";
import { getDeviceAdoptionStatus, type DeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { DEVICE_TYPE_VALUES, type DeviceStatus, type DeviceType } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const DEVICE_TYPES: DeviceType[] = [...DEVICE_TYPE_VALUES];

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All Statuses" },
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "degraded", label: "Degraded" },
  { value: "unknown", label: "Unknown" },
];

const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All Types" },
  ...DEVICE_TYPES.map((t) => ({
    value: t,
    label: t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
  })),
];

const DISCOVERY_MANAGEMENT_OPTIONS: Array<{ value: "all" | DeviceAdoptionStatus; label: string }> = [
  { value: "all", label: "All Discovery" },
  { value: "discovered", label: "Discovered" },
  { value: "ignored", label: "Ignored" },
];

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

function formatLastSeen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function scannerEvidenceSummary(device: {
  metadata: Record<string, unknown>;
}): { confidence: number; observations: number; evidenceTypes: string[] } {
  const discovery = (device.metadata.discovery as Record<string, unknown> | undefined) ?? {};
  const confidenceRaw = Number(discovery.confidence ?? 0);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
  const observationsRaw = Number(discovery.observationCount ?? 0);
  const observations = Number.isFinite(observationsRaw) ? Math.max(0, Math.floor(observationsRaw)) : 0;
  const evidenceTypesRaw = Array.isArray(discovery.evidenceTypes) ? discovery.evidenceTypes : [];
  const evidenceTypes = evidenceTypesRaw
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .slice(0, 2);
  return { confidence, observations, evidenceTypes };
}

function fingerprintSummary(device: {
  metadata: Record<string, unknown>;
  services: Array<{
    banner?: string;
    product?: string;
    version?: string;
    httpInfo?: unknown;
    tlsCert?: unknown;
  }>;
}): { version?: number; artifactCount: number; serviceRichCount: number } {
  const fingerprint = (device.metadata.fingerprint as Record<string, unknown> | undefined) ?? {};
  const versionRaw = Number(fingerprint.fingerprintVersion);
  const version = Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : undefined;
  const keys = [
    "sshBanner",
    "snmpSysDescr",
    "snmpSysName",
    "inferredOs",
    "inferredProduct",
    "dnsService",
    "winrm",
    "mqtt",
    "smbDialect",
    "netbiosName",
  ];
  const artifactCount = keys.reduce((sum, key) => {
    const value = fingerprint[key];
    const present =
      value !== undefined &&
      value !== null &&
      (!(typeof value === "string") || value.trim().length > 0);
    return sum + (present ? 1 : 0);
  }, 0);
  const serviceRichCount = device.services.filter((service) =>
    Boolean(
      (service.banner && service.banner.trim().length > 0) ||
      (service.product && service.product.trim().length > 0) ||
      (service.version && service.version.trim().length > 0) ||
      service.httpInfo ||
      service.tlsCert,
    )).length;
  return { version, artifactCount, serviceRichCount };
}

type SortField =
  | "name"
  | "ip"
  | "type"
  | "management"
  | "status"
  | "services"
  | "autonomyTier"
  | "lastSeenAt";

export type DeviceInventoryScope = "adopted" | "discovery";

export function DeviceInventoryPage({ scope }: { scope: DeviceInventoryScope }) {
  const router = useRouter();
  const { devices, loading, error, addDevice, runAgentCycle, setDeviceAdoptionStatus } = useSteward();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [managementFilter, setManagementFilter] = useState<"all" | DeviceAdoptionStatus>("all");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIp, setNewIp] = useState("");
  const [adding, setAdding] = useState(false);
  const [adoptingIds, setAdoptingIds] = useState<Record<string, boolean>>({});
  const [runningDiscoveryCycle, setRunningDiscoveryCycle] = useState(false);
  const [runFeedback, setRunFeedback] = useState<string | null>(null);
  const showDiscoveryManagementFilter = scope === "discovery";

  const scopedDevices = useMemo(() => {
    return devices.filter((device) => {
      const adoption = getDeviceAdoptionStatus(device);
      return scope === "adopted" ? adoption === "adopted" : adoption !== "adopted";
    });
  }, [devices, scope]);

  const filteredDevices = useMemo(() => {
    let result = scopedDevices;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          d.ip.toLowerCase().includes(q) ||
          d.hostname?.toLowerCase().includes(q) ||
          d.vendor?.toLowerCase().includes(q),
      );
    }

    // Status filter
    if (statusFilter !== "all") {
      result = result.filter((d) => d.status === statusFilter);
    }

    // Type filter
    if (typeFilter !== "all") {
      result = result.filter((d) => d.type === typeFilter);
    }

    if (showDiscoveryManagementFilter && managementFilter !== "all") {
      result = result.filter((d) => getDeviceAdoptionStatus(d) === managementFilter);
    }

    // Sort
    result = [...result].sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
          case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "ip":
          cmp = a.ip.localeCompare(b.ip);
          break;
        case "type":
          cmp = a.type.localeCompare(b.type);
          break;
        case "management":
          cmp = getDeviceAdoptionStatus(a).localeCompare(getDeviceAdoptionStatus(b));
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "services":
          cmp = a.services.length - b.services.length;
          break;
        case "autonomyTier":
          cmp = a.autonomyTier - b.autonomyTier;
          break;
        case "lastSeenAt":
          cmp =
            new Date(a.lastSeenAt).getTime() -
            new Date(b.lastSeenAt).getTime();
          break;
      }
      return sortAsc ? cmp : -cmp;
    });

    return result;
  }, [scopedDevices, search, statusFilter, typeFilter, showDiscoveryManagementFilter, managementFilter, sortField, sortAsc]);

  const adoptedCount = useMemo(
    () => scopedDevices.filter((d) => getDeviceAdoptionStatus(d) === "adopted").length,
    [scopedDevices],
  );
  const discoveredCount = useMemo(
    () => scopedDevices.filter((d) => getDeviceAdoptionStatus(d) === "discovered").length,
    [scopedDevices],
  );
  const fingerprintedCount = useMemo(
    () =>
      scopedDevices.filter((device) => {
        const summary = fingerprintSummary(device);
        return typeof summary.version === "number";
      }).length,
    [scopedDevices],
  );
  const richServiceCount = useMemo(
    () =>
      scopedDevices.reduce((sum, device) => {
        const summary = fingerprintSummary(device);
        return sum + summary.serviceRichCount;
      }, 0),
    [scopedDevices],
  );
  const onlineCount = useMemo(
    () => scopedDevices.filter((d) => d.status === "online").length,
    [scopedDevices],
  );
  const offlineCount = useMemo(
    () => scopedDevices.filter((d) => d.status === "offline").length,
    [scopedDevices],
  );
  const degradedCount = useMemo(
    () => scopedDevices.filter((d) => d.status === "degraded").length,
    [scopedDevices],
  );
  const topTypes = useMemo(() => {
    const counts = new Map<DeviceType, number>();
    for (const device of scopedDevices) {
      counts.set(device.type, (counts.get(device.type) ?? 0) + 1);
    }
    const total = Math.max(1, scopedDevices.length);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, count]) => ({
        type,
        count,
        pct: Math.round((count / total) * 100),
      }));
  }, [scopedDevices]);
  const inventoryTitle = scope === "adopted" ? "Devices" : "Discovery";
  const inventoryDescription =
    scope === "adopted"
      ? "Managed assets, health state, and endpoint coverage in one compact view."
      : "Discovered and ignored assets with evidence strength and quick adoption controls.";
  const summaryItems = [
    { label: "Online", value: onlineCount, toneClass: "bg-emerald-500" },
    { label: "Offline", value: offlineCount, toneClass: "bg-red-500" },
    { label: "Degraded", value: degradedCount, toneClass: "bg-amber-500" },
    {
      label: scope === "adopted" ? "Managed" : "Discovered",
      value: scope === "adopted" ? adoptedCount : discoveredCount,
      toneClass: "bg-sky-500",
    },
    { label: "Fingerprinted", value: fingerprintedCount, toneClass: "bg-slate-400" },
    { label: "Rich Endpoints", value: richServiceCount, toneClass: "bg-cyan-500" },
  ];
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const handleAddDevice = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newIp.trim()) return;

    setAdding(true);
    try {
      await addDevice(newName.trim(), newIp.trim());
      setNewName("");
      setNewIp("");
      setDialogOpen(false);
    } catch {
      // Error is handled by the context provider
    } finally {
      setAdding(false);
    }
  };

  const handleQuickAdopt = async (event: MouseEvent<HTMLButtonElement>, deviceId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (adoptingIds[deviceId]) return;
    setAdoptingIds((prev) => ({ ...prev, [deviceId]: true }));
    try {
      await setDeviceAdoptionStatus(deviceId, "adopted");
    } finally {
      setAdoptingIds((prev) => {
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    }
  };

  const handleRunDiscoveryCycle = async () => {
    if (runningDiscoveryCycle) {
      return;
    }
    setRunningDiscoveryCycle(true);
    setRunFeedback(null);

    try {
      const result = await runAgentCycle();
      if (result.summary) {
        const parts = Object.entries(result.summary)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ");
        setRunFeedback(parts ? `Cycle complete: ${parts}` : "Cycle completed.");
      } else {
        setRunFeedback(result.started ? "Cycle started. Live updates are streaming." : "Cycle trigger accepted.");
      }
    } catch (runError) {
      setRunFeedback(runError instanceof Error ? runError.message : "Run cycle failed.");
    } finally {
      setRunningDiscoveryCycle(false);
    }
  };

  const SortableHeader = ({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) => (
    <TableHead className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        onClick={() => handleSort(field)}
      >
        {children}
        <ArrowUpDown
          className={cn(
            "size-3",
            sortField === field
              ? "text-foreground"
              : "text-muted-foreground/50",
          )}
        />
      </button>
    </TableHead>
  );

  if (loading) {
    return (
      <main className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-36" />
        </div>
        <Card>
          <CardContent className="p-0 md:p-0">
            <div className="space-y-4 p-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (error) {
    return (
      <main>
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">
              Error Loading Devices
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <section className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              {scope === "adopted" ? (
                <Server className="size-5 text-muted-foreground" />
              ) : (
                <Search className="size-5 text-muted-foreground" />
              )}
              <h1 className="text-xl font-semibold tracking-tight steward-heading-font md:text-2xl">
                {inventoryTitle}
              </h1>
              <Badge variant="outline" className="tabular-nums">
                {scopedDevices.length}
              </Badge>
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {inventoryDescription}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {scope === "discovery" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleRunDiscoveryCycle()}
                disabled={runningDiscoveryCycle}
              >
                {runningDiscoveryCycle ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Running
                  </>
                ) : (
                  <>
                    <Play className="size-3.5" />
                    Run Cycle
                  </>
                )}
              </Button>
            )}

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="size-3.5" />
                  Add Device
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={handleAddDevice}>
                  <DialogHeader>
                    <DialogTitle>Add Device</DialogTitle>
                    <DialogDescription>
                      Manually register a new device on the network.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="device-name">Device Name</Label>
                      <Input
                        id="device-name"
                        placeholder="e.g. core-switch-01"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="device-ip">IP Address</Label>
                      <Input
                        id="device-ip"
                        placeholder="e.g. 192.168.1.1"
                        value={newIp}
                        onChange={(e) => setNewIp(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={adding}>
                      {adding ? "Adding..." : "Add Device"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Card interactive={false} className="border-border/80 bg-card/85 shadow-sm">
          <CardContent className="flex flex-col gap-3 p-3 md:p-4">
            <div className="flex flex-wrap gap-2">
              {summaryItems.map((item) => (
                <div
                  key={item.label}
                  className="flex min-w-[112px] items-center gap-2 rounded-md border border-border/80 bg-background/55 px-3 py-2"
                >
                  <span className={cn("size-2 rounded-full", item.toneClass)} />
                  <div className="space-y-0.5">
                    <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                      {item.label}
                    </p>
                    <p className="text-sm font-semibold tabular-nums">{item.value}</p>
                  </div>
                </div>
              ))}
            </div>

            {scope === "discovery" && runFeedback && (
              <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {runFeedback}
              </div>
            )}

            {topTypes.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Top Types
                </span>
                {topTypes.map((entry) => (
                  <Badge
                    key={entry.type}
                    variant="outline"
                    className="gap-2 rounded-md px-2.5 py-1 text-[11px] capitalize"
                  >
                    <span>{entry.type.replace(/-/g, " ")}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {entry.count}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {entry.pct}%
                    </span>
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, IP, hostname, or vendor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showDiscoveryManagementFilter && (
          <Select value={managementFilter} onValueChange={(value: "all" | DeviceAdoptionStatus) => setManagementFilter(value)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Management" />
            </SelectTrigger>
            <SelectContent>
              {DISCOVERY_MANAGEMENT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Device Table */}
      <Card className="min-h-0 flex-1 overflow-hidden bg-card/85">
        <CardContent className="flex h-full min-h-0 flex-col p-0 md:p-0">
          {filteredDevices.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Monitor className="size-10 text-muted-foreground/50" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  No devices found
                </p>
                <p className="text-xs text-muted-foreground/70">
                  {scopedDevices.length === 0
                    ? scope === "adopted"
                      ? "No adopted devices yet. Use Discovery to adopt assets into management."
                      : "No discovery assets right now. Run a scan to refresh candidates."
                    : "Try adjusting your search or filter criteria."}
                </p>
              </div>
              {devices.length === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialogOpen(true)}
                >
                  <Plus className="mr-2 size-3" />
                  Add Device
                </Button>
              )}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <SortableHeader field="status" className="pl-3 first:pl-3">Status</SortableHeader>
                    <SortableHeader field="name">Name</SortableHeader>
                    <SortableHeader field="ip">IP</SortableHeader>
                    <SortableHeader field="type">Type</SortableHeader>
                    {showDiscoveryManagementFilter && (
                      <SortableHeader field="management" className="hidden xl:table-cell">Management</SortableHeader>
                    )}
                    <SortableHeader field="services">Endpoints</SortableHeader>
                    <TableHead className="hidden xl:table-cell">Evidence</TableHead>
                    <TableHead className="hidden 2xl:table-cell">Fingerprint</TableHead>
                    <SortableHeader field="autonomyTier" className="hidden lg:table-cell">Tier</SortableHeader>
                    <SortableHeader field="lastSeenAt" className="hidden md:table-cell">
                      Last Seen
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDevices.map((device) => {
                    const evidence = scannerEvidenceSummary(device);
                    const fingerprint = fingerprintSummary(device);
                    return (
                    <TableRow
                      key={device.id}
                      className="h-11 cursor-pointer"
                      onClick={() => router.push(`/devices/${device.id}`)}
                    >
                      <TableCell className="pl-3 first:pl-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "inline-block size-2.5 rounded-full",
                              statusDotColor(device.status),
                            )}
                          />
                          <Badge
                            variant={statusBadgeVariant(device.status)}
                            className="text-[10px] capitalize"
                          >
                            {device.status}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {device.name}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {device.ip}
                      </TableCell>
                      <TableCell className="capitalize text-sm">
                        {device.type.replace(/-/g, " ")}
                      </TableCell>
                      {showDiscoveryManagementFilter && (
                        <TableCell className="hidden xl:table-cell">
                          <div className="flex items-center gap-2">
                            {getDeviceAdoptionStatus(device) === "adopted" ? (
                              <Badge variant="default" className="text-[10px]">Adopted</Badge>
                            ) : getDeviceAdoptionStatus(device) === "ignored" ? (
                              <Badge variant="outline" className="text-[10px]">Ignored</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">Discovered</Badge>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              disabled={Boolean(adoptingIds[device.id])}
                              onClick={(event) => void handleQuickAdopt(event, device.id)}
                            >
                              {adoptingIds[device.id] ? "Adopting..." : "Adopt"}
                            </Button>
                          </div>
                        </TableCell>
                      )}
                      <TableCell className="tabular-nums">
                        {device.services.length}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <div className="space-y-1">
                          <p className="text-xs tabular-nums">
                            {(evidence.confidence * 100).toFixed(0)}% conf
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {evidence.observations} obs
                          </p>
                          {evidence.evidenceTypes.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {evidence.evidenceTypes.map((type) => (
                                <Badge key={type} variant="outline" className="px-1 py-0 text-[9px]">
                                  {type.replace(/_/g, " ")}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden 2xl:table-cell">
                        <div className="space-y-1">
                          <p className="text-xs tabular-nums">
                            {fingerprint.version ? `v${fingerprint.version}` : "unversioned"}
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {fingerprint.artifactCount} artifacts
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {fingerprint.serviceRichCount} rich endpoints
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex items-center gap-1.5">
                          <Shield
                            className={cn(
                              "size-3.5",
                              device.autonomyTier === 3
                                ? "text-emerald-500"
                                : device.autonomyTier === 2
                                  ? "text-amber-500"
                                  : "text-muted-foreground",
                            )}
                          />
                          <span className="text-sm tabular-nums">
                            {device.autonomyTier}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                        {formatLastSeen(device.lastSeenAt)}
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {filteredDevices.length > 0 && (
            <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
              <p className="inline-flex items-center gap-1.5">
                <Network className="size-3.5" />
                Showing {filteredDevices.length} device{filteredDevices.length === 1 ? "" : "s"}
                {filteredDevices.length !== scopedDevices.length ? ` filtered from ${scopedDevices.length}` : ""}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
