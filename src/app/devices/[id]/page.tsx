"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Lightbulb,
  Server,
  Shield,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeviceWorkloadsPanel } from "@/components/device-workloads-panel";
import { DeviceAccessPanel } from "@/components/device-access-panel";
import { DeviceSettingsPanel } from "@/components/device-settings-panel";
import { DeviceWidgetsPanel } from "@/components/device-widgets-panel";
import { getDeviceIdentityDescription } from "@/lib/devices/identity";
import { useSteward } from "@/lib/hooks/use-steward";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import type { DeviceStatus, IncidentSeverity, RecommendationPriority } from "@/lib/state/types";
import { cn } from "@/lib/utils";
import { withClientApiToken } from "@/lib/auth/client-token";

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

const tabPanelVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 12,
    filter: "blur(8px)",
  },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      opacity: { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const },
      y: {
        type: "spring" as const,
        stiffness: 260,
        damping: 28,
        mass: 0.8,
      },
      filter: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const },
    },
  },
};

function AnimatedTabPanel({
  active,
  persistent = false,
  children,
  className,
}: {
  active: boolean;
  persistent?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={persistent || reduceMotion ? false : "hidden"}
      animate={reduceMotion ? undefined : active ? "visible" : "hidden"}
      variants={reduceMotion ? undefined : tabPanelVariants}
      className={cn("h-full min-h-0", className)}
    >
      {children}
    </motion.div>
  );
}

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const {
    devices,
    incidents,
    recommendations,
    playbookRuns,
    loading,
    error,
  } = useSteward();
  const [activeTab, setActiveTab] = useState("overview");
  const [startingOnboarding, setStartingOnboarding] = useState(false);
  const [chatSessionRefreshToken, setChatSessionRefreshToken] = useState<number | undefined>(undefined);
  const [preferredChatSessionId, setPreferredChatSessionId] = useState<string | undefined>(undefined);
  const [hasOnboardingSession, setHasOnboardingSession] = useState<boolean | null>(null);
  const [pendingOnboardingReveal, setPendingOnboardingReveal] = useState(false);
  const chatPanelRef = useRef<HTMLDivElement | null>(null);
  const previousDeviceContextRef = useRef<{
    deviceId: string | null;
    adoptionStatus: string | null;
  }>({
    deviceId: null,
    adoptionStatus: null,
  });

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

  const adoptionStatus = device ? getDeviceAdoptionStatus(device) : null;
  const adoptionMeta = asRecord(device?.metadata.adoption) ?? {};
  const onboardingRunStatus = typeof adoptionMeta.runStatus === "string"
    ? adoptionMeta.runStatus
    : undefined;
  const needsOnboardingNudge =
    adoptionStatus === "adopted" &&
    onboardingRunStatus !== "completed" &&
    hasOnboardingSession === false;

  useEffect(() => {
    if (activeTab === "adapters" || activeTab === "credentials") {
      setActiveTab("access");
    }
  }, [activeTab]);

  useEffect(() => {
    const previousContext = previousDeviceContextRef.current;
    if (
      deviceId &&
      previousContext.deviceId === deviceId &&
      previousContext.adoptionStatus !== null &&
      adoptionStatus === "adopted" &&
      previousContext.adoptionStatus !== "adopted"
    ) {
      setHasOnboardingSession(false);
    }

    previousDeviceContextRef.current = {
      deviceId: deviceId ?? null,
      adoptionStatus: adoptionStatus ?? null,
    };
  }, [adoptionStatus, deviceId]);

  useEffect(() => {
    if (!pendingOnboardingReveal || activeTab !== "steward") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      chatPanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      setPendingOnboardingReveal(false);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, pendingOnboardingReveal]);

  useEffect(() => {
    if (!deviceId || !device || adoptionStatus !== "adopted") {
      setHasOnboardingSession(null);
      return;
    }

    let cancelled = false;
    const loadOnboardingSession = async () => {
      try {
        const response = await fetch(
          `/api/devices/${deviceId}/onboarding/session`,
          withClientApiToken({ cache: "no-store" }),
        );
        const data = (await response.json()) as { session?: { id?: string } | null };
        if (!cancelled) {
          setHasOnboardingSession(Boolean(data.session?.id));
        }
      } catch {
        if (!cancelled) {
          setHasOnboardingSession(null);
        }
      }
    };

    void loadOnboardingSession();
    return () => {
      cancelled = true;
    };
  }, [adoptionStatus, device, deviceId]);

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

  const startOnboardingFromNudge = async () => {
    if (!device || startingOnboarding) return;
    setStartingOnboarding(true);
    setPendingOnboardingReveal(true);
    setActiveTab("steward");
    try {
      const res = await fetch(`/api/devices/${device.id}/onboarding/session`, withClientApiToken({ method: "POST" }));
      const data = (await res.json()) as { session?: { id?: string } | null };
      if (data.session?.id) {
        setHasOnboardingSession(true);
        setPreferredChatSessionId(undefined);
        window.requestAnimationFrame(() => {
          setPreferredChatSessionId(data.session?.id);
          setPendingOnboardingReveal(true);
        });
      }
      setChatSessionRefreshToken((prev) => (prev ?? 0) + 1);
    } finally {
      setStartingOnboarding(false);
    }
  };
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
  const dnsProbeSummary = summarizeRecord(fingerprintDnsService);
  const winrmProbeSummary = summarizeRecord(fingerprintWinrm);
  const mqttProbeSummary = summarizeRecord(fingerprintMqtt);
  const metadataHostname = typeof device.metadata.hostname === "string" && device.metadata.hostname.trim().length > 0
    ? device.metadata.hostname
    : undefined;
  const visibleEvidenceTypes = discoveryEvidenceTypes.slice(0, 6);
  const visibleSourceCounts = discoverySourceCounts.slice(0, 4);
  const visibleRecommendations = relatedRecommendations.filter((recommendation) => !recommendation.dismissed);
  const visibleClassificationSignals = topClassificationSignals.slice(0, 3);
  const visibleProtocols = device.protocols.slice(0, 8);
  const deviceDescription = getDeviceIdentityDescription(device);

  return (
    <main className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        {/* Device Header */}
        <section className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "inline-block size-3 rounded-full",
                    statusDotColor(device.status),
                  )}
                />
                <h1 className="text-xl font-semibold tracking-tight steward-heading-font md:text-2xl">
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
            <div className="flex items-start gap-2 sm:flex-col sm:items-end sm:text-right">
              <div className="text-xs text-muted-foreground">
                <p>First seen: {formatDate(device.firstSeenAt)}</p>
                <p>Last seen: {formatRelative(device.lastSeenAt)}</p>
              </div>
            </div>
          </div>

          {needsOnboardingNudge && (
            <Card className="border-amber-300/60 bg-amber-50/70 dark:border-amber-500/40 dark:bg-amber-950/20">
              <CardContent className="flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">Onboarding pending</p>
                  <p className="text-xs text-amber-800/90 dark:text-amber-200/90">
                    This device is adopted. Start onboarding from Chat so it can commit adapter selection, access, and any workloads or assurances Steward should own.
                  </p>
                </div>
                <Button size="sm" onClick={() => void startOnboardingFromNudge()} disabled={startingOnboarding}>
                  {startingOnboarding ? "Starting..." : "Start Onboarding"}
                </Button>
              </CardContent>
            </Card>
          )}
        </section>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-auto w-fit flex-wrap gap-0.5 p-1">
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="overview">Overview</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="workloads">Workloads</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="access">Access</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="widgets">Widgets</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="steward">Chat</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="activity">Activity</TabsTrigger>
            <TabsTrigger className="h-8 px-3 text-xs sm:h-9 sm:text-sm" value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
            <AnimatedTabPanel active={activeTab === "overview"} persistent className="overflow-hidden">
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
                  {deviceDescription || "Identity, confidence, and operational signal health"}
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
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Endpoints</p>
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

                <div className="space-y-2 rounded-md border bg-background/55 p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Latest Probe Signals</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded-md border bg-background/70 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">DNS</p>
                      <p className="text-xs text-muted-foreground line-clamp-1">{dnsProbeSummary ?? "n/a"}</p>
                    </div>
                    <div className="rounded-md border bg-background/70 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">WinRM</p>
                      <p className="text-xs text-muted-foreground line-clamp-1">{winrmProbeSummary ?? "n/a"}</p>
                    </div>
                    <div className="rounded-md border bg-background/70 p-2.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">MQTT</p>
                      <p className="text-xs text-muted-foreground line-clamp-1">{mqttProbeSummary ?? "n/a"}</p>
                    </div>
                    {fingerprintSnmpSysName && (
                      <div className="rounded-md border bg-background/70 p-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">SNMP sysName</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">{fingerprintSnmpSysName}</p>
                      </div>
                    )}
                    {fingerprintNetbiosName && (
                      <div className="rounded-md border bg-background/70 p-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">NetBIOS</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">{fingerprintNetbiosName}</p>
                      </div>
                    )}
                    {fingerprintSmbDialect && (
                      <div className="rounded-md border bg-background/70 p-2.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">SMB Dialect</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">{fingerprintSmbDialect}</p>
                      </div>
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

            <div className="min-h-0">
              <Card className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Lightbulb className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Recommendations</CardTitle>
                    {visibleRecommendations.length > 0 && (
                      <Badge variant="secondary" className="ml-auto tabular-nums">
                        {visibleRecommendations.length}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>Highest-impact next actions for this device</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-auto">
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
                </CardContent>
              </Card>
            </div>
              </div>
            </AnimatedTabPanel>
          </TabsContent>

        <TabsContent value="workloads" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "workloads"} persistent className="overflow-hidden">
            <div className="h-full min-h-0 overflow-hidden">
              <DeviceWorkloadsPanel deviceId={device.id} active={activeTab === "workloads"} className="h-full" />
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="access" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "access"} persistent className="overflow-auto">
            <div className="h-full min-h-0 overflow-auto">
              <DeviceAccessPanel deviceId={device.id} active={activeTab === "access"} className="h-full" />
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="widgets" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "widgets"} persistent className="overflow-hidden">
            <div className="h-full min-h-0 overflow-hidden">
              <DeviceWidgetsPanel deviceId={device.id} active={activeTab === "widgets"} className="h-full" />
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="steward" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "steward"} persistent className="overflow-hidden">
            <div ref={chatPanelRef} className="h-full min-h-0">
              <Card className="flex h-full min-h-0 min-w-0 overflow-hidden bg-card/85">
                <ChatWorkspace
                  initialDeviceId={device.id}
                  sessionScope="device"
                  respectUrlParams={false}
                  compact
                  sessionRefreshToken={chatSessionRefreshToken}
                  preferredSessionId={preferredChatSessionId}
                />
              </Card>
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="activity" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "activity"} persistent className="overflow-hidden">
            <div className="grid h-full min-h-0 gap-4 xl:grid-cols-2">
              <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Incidents</CardTitle>
                    {relatedIncidents.length > 0 && (
                      <Badge variant="secondary" className="ml-auto tabular-nums">
                        {relatedIncidents.length}
                      </Badge>
                    )}
                  </div>
                  <CardDescription>Operational issues and degradations involving this device</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1">
                  {relatedIncidents.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-8 text-center">
                      <AlertTriangle className="size-8 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">No incidents for this device</p>
                    </div>
                  ) : (
                    <ul className="h-full space-y-2 overflow-auto pr-1">
                      {relatedIncidents.map((incident) => (
                        <li key={incident.id} className="rounded-md border bg-background/75 p-3 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium">{incident.title}</p>
                            <Badge
                              variant={incidentBadgeVariant(incident.severity)}
                              className="shrink-0 text-[10px] uppercase"
                            >
                              {incident.severity}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground line-clamp-2">{incident.summary}</p>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
                            <span className="capitalize">Status: {incident.status.replace("_", " ")}</span>
                            <span>
                              <Clock className="mr-0.5 inline size-3" />
                              {formatRelative(incident.updatedAt)}
                            </span>
                            {incident.autoRemediated ? (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                Auto-remediated
                              </Badge>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card className="flex h-full min-h-0 flex-col min-w-0 bg-card/85">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Wrench className="size-4 text-muted-foreground" />
                    <CardTitle className="text-base">Execution History</CardTitle>
                    {devicePlaybookRuns.length > 0 ? (
                      <Badge variant="secondary" className="ml-auto tabular-nums">{devicePlaybookRuns.length}</Badge>
                    ) : null}
                  </div>
                  <CardDescription>Playbooks and automated remediation attempts against this device</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1">
                  {devicePlaybookRuns.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-8 text-center">
                      <Wrench className="size-8 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">No playbook runs for this device</p>
                    </div>
                  ) : (
                    <ul className="h-full space-y-2 overflow-auto pr-1">
                      {devicePlaybookRuns.map((run) => (
                        <li key={run.id} className="rounded-md border bg-background/75 p-3 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium">{run.name}</p>
                            <Badge
                              variant={
                                run.status === "completed"
                                  ? "default"
                                  : run.status === "failed" || run.status === "denied"
                                    ? "destructive"
                                    : run.status === "pending_approval"
                                      ? "secondary"
                                      : "outline"
                              }
                              className="shrink-0 text-[10px]"
                            >
                              {run.status.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{run.family} · Class {run.actionClass}</p>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
                            <span>
                              <Clock className="mr-0.5 inline size-3" />
                              {formatRelative(run.createdAt)}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="settings" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activeTab === "settings"} persistent className="overflow-auto">
            <div className="h-full min-h-0 overflow-auto">
              <DeviceSettingsPanel deviceId={device.id} />
            </div>
          </AnimatedTabPanel>
        </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
