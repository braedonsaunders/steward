"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
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
import { ChatWorkspace } from "@/components/chat-workspace";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { DeviceOnboardingPanel } from "@/components/device-onboarding-panel";
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function summarizeRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  const summary = Object.entries(record)
    .filter(([, value]) => {
      const type = typeof value;
      return type === "string" || type === "number" || type === "boolean";
    })
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
  return summary.length > 0 ? summary : "available";
}

function serviceOpenUrl(ip: string, port: number, secure: boolean): string {
  const host = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
  const scheme = secure ? "https" : "http";
  return `${scheme}://${host}:${port}`;
}

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const {
    devices,
    incidents,
    recommendations,
    playbookRuns,
    graphEdges,
    graphNodes,
    setDeviceAdoptionStatus,
    renameDevice,
    loading,
    error,
  } = useSteward();
  const [adoptionSaving, setAdoptionSaving] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [activeTab, setActiveTab] = useState("overview");

  const device = useMemo(
    () => devices.find((d) => d.id === deviceId),
    [devices, deviceId],
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
  const discoveryMeta = asRecord(device.metadata.discovery) ?? {};
  const discoveryConfidenceRaw = Number(discoveryMeta.confidence ?? 0);
  const discoveryConfidence = Number.isFinite(discoveryConfidenceRaw) ? discoveryConfidenceRaw : 0;
  const discoveryObservationsRaw = Number(discoveryMeta.observationCount ?? 0);
  const discoveryObservations = Number.isFinite(discoveryObservationsRaw)
    ? Math.max(0, Math.floor(discoveryObservationsRaw))
    : 0;
  const discoveryEvidenceTypes = asStringArray(discoveryMeta.evidenceTypes);
  const discoverySourceCountsRaw = asRecord(discoveryMeta.sourceCounts) ?? {};
  const discoverySourceCounts = Object.entries(discoverySourceCountsRaw)
    .map(([source, value]) => ({
      source,
      count: Number(value),
    }))
    .filter((entry) => Number.isFinite(entry.count) && entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const fingerprintMeta = asRecord(device.metadata.fingerprint) ?? {};
  const fingerprintVersionRaw = Number(fingerprintMeta.fingerprintVersion);
  const fingerprintVersion = Number.isFinite(fingerprintVersionRaw) ? Math.floor(fingerprintVersionRaw) : undefined;
  const fingerprintLastAt = typeof fingerprintMeta.lastFingerprintedAt === "string"
    ? fingerprintMeta.lastFingerprintedAt
    : undefined;
  const fingerprintDnsService = asRecord(fingerprintMeta.dnsService);
  const fingerprintWinrm = asRecord(fingerprintMeta.winrm);
  const fingerprintMqtt = asRecord(fingerprintMeta.mqtt);
  const fingerprintProtocolHintsRaw = Array.isArray(fingerprintMeta.protocolHints)
    ? fingerprintMeta.protocolHints
    : [];
  const fingerprintProtocolHints = fingerprintProtocolHintsRaw
    .map((hint) => asRecord(hint))
    .filter((hint): hint is Record<string, unknown> => Boolean(hint))
    .map((hint) => ({
      port: Number(hint.port),
      protocol: typeof hint.protocol === "string" ? hint.protocol : "unknown",
      confidence: Number(hint.confidence),
      secure: Boolean(hint.secure),
      banner: typeof hint.banner === "string" ? hint.banner : undefined,
      evidence: typeof hint.evidence === "string" ? hint.evidence : undefined,
    }))
    .filter((hint) => Number.isFinite(hint.port) && hint.port > 0);

  const classificationMeta = asRecord(device.metadata.classification) ?? {};
  const classificationConfidenceRaw = Number(classificationMeta.confidence ?? 0);
  const classificationConfidence = Number.isFinite(classificationConfidenceRaw)
    ? classificationConfidenceRaw
    : 0;
  const classificationSignalsRaw = Array.isArray(classificationMeta.signals)
    ? classificationMeta.signals
    : [];
  const classificationSignals = classificationSignalsRaw
    .map((signal) => asRecord(signal))
    .filter((signal): signal is Record<string, unknown> => Boolean(signal))
    .map((signal) => ({
      source: typeof signal.source === "string" ? signal.source : "unknown",
      type: typeof signal.type === "string" ? signal.type : "unknown",
      weight: Number(signal.weight),
      reason: typeof signal.reason === "string" ? signal.reason : "No reason",
    }))
    .filter((signal) => Number.isFinite(signal.weight))
    .sort((a, b) => b.weight - a.weight);
  const topClassificationSignals = classificationSignals.slice(0, 4);
  const fingerprintInferredOs = typeof fingerprintMeta.inferredOs === "string" && fingerprintMeta.inferredOs.trim().length > 0
    ? fingerprintMeta.inferredOs
    : (device.os ?? "unknown");
  const fingerprintInferredProduct = typeof fingerprintMeta.inferredProduct === "string" && fingerprintMeta.inferredProduct.trim().length > 0
    ? fingerprintMeta.inferredProduct
    : "unknown";
  const fingerprintSnmpSysName = typeof fingerprintMeta.snmpSysName === "string" && fingerprintMeta.snmpSysName.trim().length > 0
    ? fingerprintMeta.snmpSysName
    : undefined;
  const fingerprintNetbiosName = typeof fingerprintMeta.netbiosName === "string" && fingerprintMeta.netbiosName.trim().length > 0
    ? fingerprintMeta.netbiosName
    : undefined;
  const fingerprintSmbDialect = typeof fingerprintMeta.smbDialect === "string" && fingerprintMeta.smbDialect.trim().length > 0
    ? fingerprintMeta.smbDialect
    : undefined;
  const fingerprintSshBanner = typeof fingerprintMeta.sshBanner === "string" && fingerprintMeta.sshBanner.trim().length > 0
    ? fingerprintMeta.sshBanner
    : undefined;
  const fingerprintSnmpSysDescr = typeof fingerprintMeta.snmpSysDescr === "string" && fingerprintMeta.snmpSysDescr.trim().length > 0
    ? fingerprintMeta.snmpSysDescr
    : undefined;
  const dnsProbeSummary = summarizeRecord(fingerprintDnsService);
  const winrmProbeSummary = summarizeRecord(fingerprintWinrm);
  const mqttProbeSummary = summarizeRecord(fingerprintMqtt);
  const metadataHostname = typeof device.metadata.hostname === "string" && device.metadata.hostname.trim().length > 0
    ? device.metadata.hostname
    : undefined;
  const visibleEvidenceTypes = discoveryEvidenceTypes.slice(0, 6);
  const visibleSourceCounts = discoverySourceCounts.slice(0, 4);
  const visibleRecommendations = relatedRecommendations.slice(0, 4);
  const hiddenRecommendationCount = Math.max(0, relatedRecommendations.length - visibleRecommendations.length);
  const visibleClassificationSignals = topClassificationSignals.slice(0, 3);
  const visibleProtocols = device.protocols.slice(0, 8);

  const updateAdoption = async (status: DeviceAdoptionStatus) => {
    setAdoptionSaving(true);
    try {
      await setDeviceAdoptionStatus(device.id, status);
    } finally {
      setAdoptionSaving(false);
    }
  };

  const openRenameDialog = () => {
    setRenameValue(device.name);
    setRenameDialogOpen(true);
  };

  const handleRenameDevice = async () => {
    const nextName = renameValue.trim();
    if (!nextName) return;
    if (nextName === device.name) {
      setRenameDialogOpen(false);
      return;
    }

    setRenameSaving(true);
    try {
      await renameDevice(device.id, nextName);
      setRenameDialogOpen(false);
    } finally {
      setRenameSaving(false);
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
              <h1 className="text-2xl font-semibold tracking-tight steward-heading-font md:text-3xl">
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
          </div>
          <div className="flex items-end gap-2 sm:flex-col sm:text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="sm" variant="outline" disabled={adoptionSaving}>
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  disabled={adoptionSaving || renameSaving || adoptionStatus !== "adopted"}
                  onClick={openRenameDialog}
                >
                  Rename Device
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={adoptionSaving || adoptionStatus === "adopted"}
                  onClick={() => void updateAdoption("adopted")}
                >
                  Adopt For Management
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={adoptionSaving || adoptionStatus === "discovered"}
                  onClick={() => void updateAdoption("discovered")}
                >
                  Keep As Discovered
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={adoptionSaving || adoptionStatus === "ignored"}
                  onClick={() => void updateAdoption("ignored")}
                >
                  Ignore Device
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Rename Device</DialogTitle>
                  <DialogDescription>
                    Update the managed display name for this adopted device.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2 py-2">
                  <Label htmlFor="rename-device-name">Device Name</Label>
                  <Input
                    id="rename-device-name"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    placeholder="e.g. nas-01"
                    disabled={renameSaving}
                    autoFocus
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRenameDialogOpen(false)}
                    disabled={renameSaving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleRenameDevice()}
                    disabled={renameSaving || renameValue.trim().length === 0}
                  >
                    {renameSaving ? "Saving..." : "Save Name"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <div className="text-sm text-muted-foreground">
              <p>First seen: {formatDate(device.firstSeenAt)}</p>
              <p>Last seen: {formatRelative(device.lastSeenAt)}</p>
            </div>
          </div>
        </div>

      </section>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contracts">Contracts</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
          <TabsTrigger value="incidents">Incidents</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[1.5fr_1fr]">
            <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-br from-primary/10 via-card to-secondary/10">
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute -top-16 left-2 h-28 w-28 rounded-full bg-primary/20 blur-3xl" />
                <div className="absolute -bottom-16 right-0 h-32 w-32 rounded-full bg-secondary/30 blur-3xl" />
              </div>
              <CardHeader className="relative pb-3">
                <div className="flex items-center gap-2">
                  <Server className="size-4 text-primary" />
                  <CardTitle className="text-base">Device Snapshot</CardTitle>
                  <Badge variant="outline" className="ml-auto text-[10px] capitalize">
                    {String(discoveryMeta.status ?? device.status)}
                  </Badge>
                </div>
                <CardDescription>
                  Identity, confidence, and operational signal health
                </CardDescription>
              </CardHeader>
              <CardContent className="relative space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-md border bg-background/65 p-2.5 text-center">
                    <p className="text-base font-semibold tabular-nums">{(discoveryConfidence * 100).toFixed(0)}%</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Discovery</p>
                  </div>
                  <div className="rounded-md border bg-background/65 p-2.5 text-center">
                    <p className="text-base font-semibold tabular-nums">{discoveryObservations}</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Observations</p>
                  </div>
                  <div className="rounded-md border bg-background/65 p-2.5 text-center">
                    <p className="text-base font-semibold tabular-nums">{(classificationConfidence * 100).toFixed(0)}%</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Classifier</p>
                  </div>
                  <div className="rounded-md border bg-background/65 p-2.5 text-center">
                    <p className="text-base font-semibold tabular-nums">{device.services.length}</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Services</p>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded-md border bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">IP Address</p>
                    <p className="font-mono text-sm">{device.ip}</p>
                  </div>
                  {(device.hostname || metadataHostname) && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Hostname</p>
                      <p className="text-sm line-clamp-1">{device.hostname ?? metadataHostname}</p>
                    </div>
                  )}
                  {device.mac && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">MAC Address</p>
                      <p className="font-mono text-sm line-clamp-1">{device.mac}</p>
                    </div>
                  )}
                  {device.vendor && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Vendor</p>
                      <p className="text-sm line-clamp-1">{device.vendor}</p>
                    </div>
                  )}
                  {device.os && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Operating System</p>
                      <p className="text-sm line-clamp-1">{device.os}</p>
                    </div>
                  )}
                  {device.role && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Role</p>
                      <p className="text-sm line-clamp-1">{device.role}</p>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-md border bg-background/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Discovery Evidence</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {visibleEvidenceTypes.length > 0 ? (
                        visibleEvidenceTypes.map((type) => (
                          <Badge key={type} variant="outline" className="text-[10px]">
                            {type.replace(/_/g, " ")}
                          </Badge>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">No evidence tags yet</p>
                      )}
                    </div>
                    {visibleSourceCounts.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {visibleSourceCounts.map((entry) => (
                          <div key={entry.source} className="flex items-center justify-between text-xs">
                            <span className="capitalize text-muted-foreground">{entry.source}</span>
                            <span className="font-mono tabular-nums">{entry.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-md border bg-background/60 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Fingerprint Context</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded border bg-background/60 p-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Version</p>
                        <p className="font-mono">{fingerprintVersion ? `v${fingerprintVersion}` : "none"}</p>
                      </div>
                      <div className="rounded border bg-background/60 p-2">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Last Probe</p>
                        <p>{fingerprintLastAt ? formatRelative(fingerprintLastAt) : "never"}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground line-clamp-1">
                      OS: <span className="text-foreground/90">{fingerprintInferredOs}</span>
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      Product: <span className="text-foreground/90">{fingerprintInferredProduct}</span>
                    </p>
                    {fingerprintSshBanner && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-1">
                        SSH: <span className="text-foreground/90">{fingerprintSshBanner}</span>
                      </p>
                    )}
                  </div>
                </div>

                {visibleProtocols.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Protocols</p>
                    <div className="flex flex-wrap gap-1">
                      {visibleProtocols.map((protocol) => (
                        <Badge key={protocol} variant="outline" className="text-[10px]">
                          {protocol}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {visibleClassificationSignals.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Top Classification Signals</p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {visibleClassificationSignals.map((signal, idx) => (
                        <div key={`${signal.source}-${signal.type}-${idx}`} className="rounded-md border bg-background/60 p-2 text-xs">
                          <div className="flex items-center justify-between gap-1">
                            <span className="capitalize line-clamp-1">{signal.source}</span>
                            <span className="font-mono tabular-nums text-muted-foreground">{signal.weight}</span>
                          </div>
                          <p className="text-muted-foreground line-clamp-2">{signal.reason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid min-h-0 gap-4">
              <Card className="bg-card/85">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Contracts & Onboarding</CardTitle>
                  </div>
                  <CardDescription>
                    Manage endpoint contracts, credentials, monitor expectations, and onboarding state.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button size="sm" type="button" onClick={() => setActiveTab("contracts")}>
                    Open Contracts Tab
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/devices/${device.id}/onboarding`}>Open Full-Page View</Link>
                  </Button>
                </CardContent>
              </Card>

              <Card className="overflow-hidden bg-card/85">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Recommendations</CardTitle>
                    {relatedRecommendations.length > 0 && (
                      <Badge variant="secondary" className="ml-auto tabular-nums">
                        {relatedRecommendations.length}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>Highest-impact next actions for this device</CardDescription>
                </CardHeader>
                <CardContent>
                  {visibleRecommendations.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-6 text-center">
                      <Lightbulb className="size-8 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">No recommendations for this device</p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {visibleRecommendations.map((rec) => (
                        <li
                          key={rec.id}
                          className={cn(
                            "rounded-md border bg-background/75 p-3 space-y-1.5",
                            rec.dismissed && "opacity-60",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium line-clamp-1">{rec.title}</p>
                            <Badge
                              variant={recommendationBadgeVariant(rec.priority)}
                              className="shrink-0 text-[10px] uppercase"
                            >
                              {rec.priority}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{rec.rationale}</p>
                          <p className="text-[10px] text-muted-foreground/70 line-clamp-1">Impact: {rec.impact}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hiddenRecommendationCount > 0 && (
                    <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      +{hiddenRecommendationCount} more in incidents/history views
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className="overflow-hidden bg-card/85">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Probe Snapshot</CardTitle>
                  </div>
                  <CardDescription>Latest protocol probe outcomes and key banners</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  <div className="rounded-md border bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">DNS</p>
                    <p className="text-muted-foreground line-clamp-1">{dnsProbeSummary ?? "n/a"}</p>
                  </div>
                  <div className="rounded-md border bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">WinRM</p>
                    <p className="text-muted-foreground line-clamp-1">{winrmProbeSummary ?? "n/a"}</p>
                  </div>
                  <div className="rounded-md border bg-background/60 p-2.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">MQTT</p>
                    <p className="text-muted-foreground line-clamp-1">{mqttProbeSummary ?? "n/a"}</p>
                  </div>
                  {fingerprintSnmpSysName && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">SNMP sysName</p>
                      <p className="text-muted-foreground line-clamp-1">{fingerprintSnmpSysName}</p>
                    </div>
                  )}
                  {fingerprintNetbiosName && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">NetBIOS</p>
                      <p className="text-muted-foreground line-clamp-1">{fingerprintNetbiosName}</p>
                    </div>
                  )}
                  {fingerprintSmbDialect && (
                    <div className="rounded-md border bg-background/60 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">SMB Dialect</p>
                      <p className="text-muted-foreground line-clamp-1">{fingerprintSmbDialect}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="contracts" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <div className="h-full min-h-0 overflow-hidden">
            <DeviceOnboardingPanel deviceId={device.id} className="h-full" />
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
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="rounded-md border bg-background/50 p-3">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Protocol Intelligence
                  </p>
                  {fingerprintProtocolHints.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">No protocol hints recorded</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {fingerprintProtocolHints.slice(0, 8).map((hint, idx) => {
                        const confidence = Number.isFinite(hint.confidence)
                          ? `${(hint.confidence * 100).toFixed(0)}%`
                          : "n/a";
                        return (
                          <Badge key={`${hint.port}-${hint.protocol}-${idx}`} variant="outline" className="gap-1 text-[10px]">
                            <span className="font-mono">{hint.port}</span>
                            <span>{hint.protocol}</span>
                            <span className="text-muted-foreground">{confidence}</span>
                            {hint.secure ? <Lock className="size-3" /> : null}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="rounded-md border bg-background/50 p-3">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Probe Results
                  </p>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                    <p><span className="text-foreground/85">DNS:</span> {dnsProbeSummary ?? "n/a"}</p>
                    <p><span className="text-foreground/85">WinRM:</span> {winrmProbeSummary ?? "n/a"}</p>
                    <p><span className="text-foreground/85">MQTT:</span> {mqttProbeSummary ?? "n/a"}</p>
                  </div>
                </div>
                <div className="rounded-md border bg-background/50 p-3">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Banner Signals
                  </p>
                  <div className="mt-2 space-y-2 text-xs">
                    {fingerprintSshBanner && (
                      <p className="break-all text-muted-foreground">
                        <span className="text-foreground/85">SSH:</span> {fingerprintSshBanner.slice(0, 120)}
                      </p>
                    )}
                    {fingerprintSnmpSysDescr && (
                      <p className="break-words text-muted-foreground">
                        <span className="text-foreground/85">SNMP:</span> {fingerprintSnmpSysDescr.slice(0, 120)}
                      </p>
                    )}
                    {!fingerprintSshBanner && !fingerprintSnmpSysDescr && (
                      <p className="text-muted-foreground">No banner artifacts captured</p>
                    )}
                  </div>
                </div>
              </div>

              {device.services.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border py-8 text-center">
                  <Wifi className="size-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No services discovered yet</p>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Port</TableHead>
                        <TableHead>Transport</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead>Secure</TableHead>
                        <TableHead>Open</TableHead>
                        <TableHead>Artifacts</TableHead>
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
                          <TableCell>
                            <Button asChild type="button" variant="outline" size="sm" className="h-6 px-2 text-[10px]">
                              <a
                                href={serviceOpenUrl(device.ip, svc.port, svc.secure)}
                                target="_blank"
                                rel="noreferrer noopener"
                                onClick={(event) => event.stopPropagation()}
                              >
                                Open
                              </a>
                            </Button>
                          </TableCell>
                          <TableCell className="max-w-[420px]">
                            <div className="space-y-1 text-xs text-muted-foreground">
                              {svc.banner && (
                                <p className="break-all">
                                  <span className="font-medium text-foreground/80">Banner:</span>{" "}
                                  {svc.banner.slice(0, 220)}
                                </p>
                              )}
                              {svc.httpInfo && (
                                <p className="break-all">
                                  <span className="font-medium text-foreground/80">HTTP:</span>{" "}
                                  {[
                                    svc.httpInfo.serverHeader,
                                    svc.httpInfo.title,
                                    svc.httpInfo.poweredBy,
                                    svc.httpInfo.generator,
                                  ].filter(Boolean).join(" | ") || "present"}
                                </p>
                              )}
                              {svc.tlsCert && (
                                <p className="break-all">
                                  <span className="font-medium text-foreground/80">TLS:</span>{" "}
                                  {svc.tlsCert.subject || "subject n/a"}
                                  {svc.tlsCert.validTo ? ` (exp ${svc.tlsCert.validTo})` : ""}
                                </p>
                              )}
                              {!svc.banner && !svc.httpInfo && !svc.tlsCert && (
                                <p>-</p>
                              )}
                              <p className="font-mono text-[10px]">seen {formatRelative(svc.lastSeenAt)}</p>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="chat" className="mt-4 min-h-0 flex-1 overflow-hidden">
          <ChatWorkspace initialDeviceId={device.id} compact respectUrlParams={false} />
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
