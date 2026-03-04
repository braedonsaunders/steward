"use client";

import { type FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  Monitor,
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
import type { DeviceStatus, DeviceType } from "@/lib/state/types";
import { cn } from "@/lib/utils";

const DEVICE_TYPES: DeviceType[] = [
  "server",
  "workstation",
  "router",
  "switch",
  "access-point",
  "nas",
  "printer",
  "iot",
  "container-host",
  "hypervisor",
  "unknown",
];

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

type SortField =
  | "name"
  | "ip"
  | "type"
  | "status"
  | "services"
  | "autonomyTier"
  | "lastSeenAt";

export default function DevicesPage() {
  const router = useRouter();
  const { devices, loading, error, addDevice } = useSteward();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortAsc, setSortAsc] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIp, setNewIp] = useState("");
  const [adding, setAdding] = useState(false);

  const filteredDevices = useMemo(() => {
    let result = devices;

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
  }, [devices, search, statusFilter, typeFilter, sortField, sortAsc]);

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

  const SortableHeader = ({
    field,
    children,
  }: {
    field: SortField;
    children: React.ReactNode;
  }) => (
    <TableHead>
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
      <main className="mx-auto w-full max-w-[1380px] space-y-6 py-6 md:py-8">
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
          <CardContent className="p-0">
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
      <main className="mx-auto w-full max-w-[1380px] py-6 md:py-8">
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
    <main className="mx-auto w-full max-w-[1380px] space-y-6 py-6 md:py-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <Server className="size-6 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Devices
            </h1>
            <Badge variant="secondary" className="tabular-nums">
              {devices.length}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Discovered and managed network assets
          </p>
        </div>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 size-4" />
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
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="bg-card/85">
          <CardContent className="p-3">
            <p className="text-2xl font-semibold tabular-nums">
              {devices.filter((d) => d.status === "online").length}
            </p>
            <p className="text-xs text-muted-foreground">Online</p>
          </CardContent>
        </Card>
        <Card className="bg-card/85">
          <CardContent className="p-3">
            <p className="text-2xl font-semibold tabular-nums">
              {devices.filter((d) => d.status === "offline").length}
            </p>
            <p className="text-xs text-muted-foreground">Offline</p>
          </CardContent>
        </Card>
        <Card className="bg-card/85">
          <CardContent className="p-3">
            <p className="text-2xl font-semibold tabular-nums">
              {devices.filter((d) => d.status === "degraded").length}
            </p>
            <p className="text-xs text-muted-foreground">Degraded</p>
          </CardContent>
        </Card>
        <Card className="bg-card/85">
          <CardContent className="p-3">
            <p className="text-2xl font-semibold tabular-nums">
              {devices.reduce((sum, d) => sum + d.services.length, 0)}
            </p>
            <p className="text-xs text-muted-foreground">Total Services</p>
          </CardContent>
        </Card>
      </div>

      {/* Device Table */}
      <Card className="bg-card/85">
        <CardContent className="p-0">
          {filteredDevices.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Monitor className="size-10 text-muted-foreground/50" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  No devices found
                </p>
                <p className="text-xs text-muted-foreground/70">
                  {devices.length === 0
                    ? "Add a device or run an agent cycle to discover network assets."
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
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader field="status">Status</SortableHeader>
                    <SortableHeader field="name">Name</SortableHeader>
                    <SortableHeader field="ip">IP</SortableHeader>
                    <SortableHeader field="type">Type</SortableHeader>
                    <SortableHeader field="services">Services</SortableHeader>
                    <SortableHeader field="autonomyTier">Tier</SortableHeader>
                    <SortableHeader field="lastSeenAt">
                      Last Seen
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDevices.map((device) => (
                    <TableRow
                      key={device.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/devices/${device.id}`)}
                    >
                      <TableCell>
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
                      <TableCell className="tabular-nums">
                        {device.services.length}
                      </TableCell>
                      <TableCell>
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
                      <TableCell className="text-sm text-muted-foreground">
                        {formatLastSeen(device.lastSeenAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results count */}
      {filteredDevices.length > 0 && filteredDevices.length !== devices.length && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filteredDevices.length} of {devices.length} devices
        </p>
      )}
    </main>
  );
}
