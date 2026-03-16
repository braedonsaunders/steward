"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { DeviceRemoteDesktopPanel } from "@/components/device-remote-desktop-panel";
import { DeviceAutomationsPanel } from "@/components/device-automations-panel";
import { DeviceSettingsPanel } from "@/components/device-settings-panel";
import { DeviceWidgetsPanel } from "@/components/device-widgets-panel";
import { getDeviceIdentityDescription } from "@/lib/devices/identity";
import { useChatRuntime, type ChatMessageRecord, type ChatSessionRecord } from "@/lib/hooks/use-chat-runtime";
import { useSteward } from "@/lib/hooks/use-steward";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import type {
  DeviceStatus,
  ChatToolWidgetMutation,
  IncidentSeverity,
  RecommendationPriority,
} from "@/lib/state/types";
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

function cleanSnapshotVendor(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  const withoutAddress = normalized.split(/,\s*\d/, 1)[0] ?? normalized;
  const cleaned = withoutAddress.replace(/^["']+|["',\s]+$/g, "").trim();
  return cleaned || normalized;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

function formatProtocolChip(protocol: string): string {
  return protocol
    .trim()
    .split("-")
    .filter(Boolean)
    .map((segment) => {
      if (segment.length <= 4) {
        return segment.toUpperCase();
      }
      return `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`;
    })
    .join(" ");
}

function formatServiceLabel(name: string | undefined, port: number): string {
  const normalized = name?.trim();
  if (!normalized || normalized === "unknown") {
    return `Port ${port}`;
  }
  return formatProtocolChip(normalized.replace(/[_/]/g, "-"));
}

function formatServiceDetail(service: {
  port: number;
  transport: "tcp" | "udp";
  product?: string;
  version?: string;
  secure: boolean;
}): string {
  const parts = [`${service.port}/${service.transport.toUpperCase()}`];
  if (service.product?.trim()) {
    parts.push(service.product.trim());
  }
  if (service.version?.trim()) {
    parts.push(`v${service.version.trim()}`);
  } else if (service.secure) {
    parts.push("TLS");
  }
  return parts.join(" | ");
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
      className={cn("h-full min-h-0 min-w-0", className)}
    >
      {children}
    </motion.div>
  );
}

function SnapshotField({
  label,
  value,
  mono = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border/70 bg-background/80 p-3.5", className)}>
      <p className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1.5 break-words text-sm font-medium leading-5 text-foreground",
          mono && "break-all font-mono text-[13px]",
        )}
      >
        {value}
      </p>
    </div>
  );
}

type DevicePrimaryTab =
  | "overview"
  | "steward"
  | "remote"
  | "widgets"
  | "manage"
  | "activity"
  | "settings";

type DeviceManageTab = "access" | "workloads" | "automations";

export default function DeviceDetailPage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const { hydrateSession } = useChatRuntime();
  const {
    devices,
    incidents,
    recommendations,
    playbookRuns,
    loading,
    error,
  } = useSteward();
  const [activePrimaryTab, setActivePrimaryTab] = useState<DevicePrimaryTab>("overview");
  const [activeManageTab, setActiveManageTab] = useState<DeviceManageTab>("access");
  const [startingOnboarding, setStartingOnboarding] = useState(false);
  const [chatSessionRefreshToken, setChatSessionRefreshToken] = useState<number | undefined>(undefined);
  const [preferredChatSessionId, setPreferredChatSessionId] = useState<string | undefined>(undefined);
  const [hasOnboardingSession, setHasOnboardingSession] = useState<boolean | null>(null);
  const [pendingOnboardingReveal, setPendingOnboardingReveal] = useState(false);
  const [latestWidgetMutation, setLatestWidgetMutation] = useState<ChatToolWidgetMutation | null>(null);
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
    if (!pendingOnboardingReveal || activePrimaryTab !== "steward") {
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
  }, [activePrimaryTab, pendingOnboardingReveal]);

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

  useEffect(() => {
    setLatestWidgetMutation(null);
  }, [deviceId]);

  const handleWidgetMutation = useCallback((mutation: ChatToolWidgetMutation) => {
    if (mutation.deviceId !== deviceId) {
      return;
    }
    setLatestWidgetMutation({ ...mutation });
  }, [deviceId]);

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
    setActivePrimaryTab("steward");
    try {
      const res = await fetch(`/api/devices/${device.id}/onboarding/session`, withClientApiToken({ method: "POST" }));
      const data = (await res.json()) as {
        session?: ChatSessionRecord | null;
        messages?: ChatMessageRecord[];
      };
      if (data.session?.id) {
        hydrateSession(data.session, data.messages ?? []);
        setHasOnboardingSession(true);
        setPreferredChatSessionId(data.session.id);
        setPendingOnboardingReveal(true);
      }
      setChatSessionRefreshToken((prev) => (prev ?? 0) + 1);
    } finally {
      setStartingOnboarding(false);
    }
  };
  const visibleRecommendations = relatedRecommendations.filter((recommendation) => !recommendation.dismissed);
  const visibleProtocols = device.protocols.slice(0, 8);
  const deviceDescription = getDeviceIdentityDescription(device);
  const metadataHostname = typeof device.metadata.hostname === "string" && device.metadata.hostname.trim().length > 0
    ? device.metadata.hostname.trim()
    : undefined;
  const snapshotHostname = device.hostname?.trim() || metadataHostname;
  const snapshotSecondaryIps = (device.secondaryIps ?? [])
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0 && ip !== device.ip)
    .slice(0, 3);
  const snapshotServices = [...device.services]
    .sort((left, right) => left.port - right.port)
    .slice(0, 4);
  const hiddenServiceCount = Math.max(0, device.services.length - snapshotServices.length);
  const snapshotVendor = cleanSnapshotVendor(device.vendor) ?? "Not identified";
  const snapshotOs = device.os?.trim() || "Not identified";
  const snapshotRole = device.role?.trim() || "Not classified";
  const snapshotMac = device.mac?.trim() || "Not observed";
  const snapshotProtocols = visibleProtocols.length > 0 ? visibleProtocols : ["No protocols observed"];

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

        <Tabs
          value={activePrimaryTab}
          onValueChange={(value) => setActivePrimaryTab(value as DevicePrimaryTab)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <TabsList className="h-auto w-fit flex-wrap justify-start self-start">
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="overview">Overview</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="steward">Chat</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="remote">Remote</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="widgets">Widgets</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="manage">Manage</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="activity">Activity</TabsTrigger>
            <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
            <AnimatedTabPanel active={activePrimaryTab === "overview"} persistent className="overflow-hidden">
              <div className="grid h-full min-h-0 min-w-0 gap-4 xl:grid-cols-[1.5fr_1fr]">
                <Card className="overflow-hidden border-border/70 bg-[linear-gradient(160deg,rgba(14,116,144,0.08),rgba(255,255,255,0.9)_45%,rgba(14,165,233,0.05))]">
                  <CardHeader className="pb-4">
                    <div className="flex items-start gap-3">
                      <div className="rounded-2xl border border-primary/20 bg-background/90 p-3 shadow-sm">
                        <Server className="size-4 text-primary" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                          At a glance
                        </p>
                        <CardTitle className="text-base">Device Snapshot</CardTitle>
                        <CardDescription className="max-w-2xl">
                          {deviceDescription || "The essentials a person needs before deciding what to do with this device."}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex min-h-0 flex-1 flex-col gap-3.5">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <SnapshotField label="IP Address" value={device.ip} mono />
                      <SnapshotField label="MAC Address" value={snapshotMac} mono />
                      <SnapshotField label="Vendor" value={snapshotVendor} className="md:col-span-2 xl:col-span-1" />
                      <SnapshotField label="Operating System" value={snapshotOs} />
                      <SnapshotField label="Role" value={snapshotRole} />
                    </div>

                    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
                      <div className="rounded-2xl border border-border/70 bg-background/88 p-4 shadow-sm">
                        <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                          Observed Services
                        </p>
                        <div className="mt-3 space-y-2.5">
                          {snapshotServices.length > 0 ? (
                            snapshotServices.map((service) => (
                              <div
                                key={service.id}
                                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-background/80 px-3 py-2.5"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {formatServiceLabel(service.name, service.port)}
                                  </p>
                                  <p className="mt-1 truncate text-xs text-muted-foreground">
                                    {formatServiceDetail(service)}
                                  </p>
                                </div>
                                <span className="shrink-0 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                  {service.transport}
                                </span>
                              </div>
                            ))
                          ) : (
                            <p className="text-sm text-muted-foreground">No endpoints observed yet.</p>
                          )}
                          {hiddenServiceCount > 0 && (
                            <p className="text-xs text-muted-foreground">
                              +{hiddenServiceCount} more endpoint{hiddenServiceCount === 1 ? "" : "s"}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-border/70 bg-background/88 p-4 shadow-sm">
                        <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                          Access And Addresses
                        </p>

                        <div className="mt-3 space-y-3">
                          <div>
                            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                              Protocols
                            </p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {snapshotProtocols.map((protocol) => (
                                <span
                                  key={protocol}
                                  className="inline-flex min-h-7 items-center rounded-full border border-border/70 bg-muted/55 px-3 py-1 text-xs font-medium text-foreground"
                                >
                                  {formatProtocolChip(protocol)}
                                </span>
                              ))}
                            </div>
                          </div>

                          {snapshotHostname && snapshotHostname !== device.name && (
                            <div className="rounded-xl border border-border/60 bg-background/80 px-3 py-2.5">
                              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                                Hostname
                              </p>
                              <p className="mt-1.5 break-words text-sm font-medium text-foreground">
                                {snapshotHostname}
                              </p>
                            </div>
                          )}

                          <div className="rounded-xl border border-border/60 bg-background/80 px-3 py-2.5">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                              Additional IPs
                            </p>
                            {snapshotSecondaryIps.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {snapshotSecondaryIps.map((ip) => (
                                  <span
                                    key={ip}
                                    className="inline-flex items-center rounded-full border border-border/70 bg-background px-2.5 py-1 font-mono text-[12px] text-foreground"
                                  >
                                    {ip}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <p className="mt-1.5 text-sm text-muted-foreground">
                                No secondary addresses observed.
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div className="min-h-0 min-w-0">
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

          <TabsContent value="steward" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
            <AnimatedTabPanel active={activePrimaryTab === "steward"} persistent className="overflow-hidden">
              <div ref={chatPanelRef} className="h-full min-h-0 min-w-0">
                <Card className="flex h-full min-h-0 min-w-0 overflow-hidden bg-card/85">
                  <ChatWorkspace
                    initialDeviceId={device.id}
                    sessionScope="device"
                    respectUrlParams={false}
                    compact
                    sessionRefreshToken={chatSessionRefreshToken}
                    preferredSessionId={preferredChatSessionId}
                    onWidgetMutation={handleWidgetMutation}
                  />
                </Card>
              </div>
            </AnimatedTabPanel>
          </TabsContent>

        <TabsContent value="remote" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activePrimaryTab === "remote"} persistent className="overflow-hidden">
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              <DeviceRemoteDesktopPanel
                deviceId={device.id}
                deviceName={device.name}
                deviceIp={device.ip}
                protocols={device.protocols}
                active={activePrimaryTab === "remote"}
                className="h-full"
              />
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="widgets" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activePrimaryTab === "widgets"} persistent className="overflow-hidden">
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              <DeviceWidgetsPanel
                deviceId={device.id}
                active={activePrimaryTab === "widgets"}
                widgetMutation={latestWidgetMutation}
                className="h-full"
              />
            </div>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="manage" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activePrimaryTab === "manage"} persistent className="overflow-hidden">
            <Tabs
              value={activeManageTab}
              onValueChange={(value) => setActiveManageTab(value as DeviceManageTab)}
              className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden"
            >
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Manage</p>
                <p className="text-xs text-muted-foreground">
                  Access, responsibilities, and automations for this device.
                </p>
              </div>
              <TabsList className="h-auto w-fit flex-wrap justify-start self-start">
                <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="access">Access</TabsTrigger>
                <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="workloads">Workloads</TabsTrigger>
                <TabsTrigger className="h-8 flex-none px-3 text-xs sm:h-9 sm:text-sm" value="automations">Automations</TabsTrigger>
              </TabsList>

              <TabsContent value="access" forceMount className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                <AnimatedTabPanel
                  active={activePrimaryTab === "manage" && activeManageTab === "access"}
                  persistent
                  className="overflow-auto"
                >
                  <div className="h-full min-h-0 min-w-0 overflow-auto">
                    <DeviceAccessPanel
                      deviceId={device.id}
                      active={activePrimaryTab === "manage" && activeManageTab === "access"}
                      className="h-full"
                    />
                  </div>
                </AnimatedTabPanel>
              </TabsContent>

              <TabsContent value="workloads" forceMount className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                <AnimatedTabPanel
                  active={activePrimaryTab === "manage" && activeManageTab === "workloads"}
                  persistent
                  className="overflow-hidden"
                >
                  <div className="h-full min-h-0 min-w-0 overflow-hidden">
                    <DeviceWorkloadsPanel
                      deviceId={device.id}
                      active={activePrimaryTab === "manage" && activeManageTab === "workloads"}
                      className="h-full"
                    />
                  </div>
                </AnimatedTabPanel>
              </TabsContent>

              <TabsContent value="automations" forceMount className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                <AnimatedTabPanel
                  active={activePrimaryTab === "manage" && activeManageTab === "automations"}
                  persistent
                  className="overflow-hidden"
                >
                  <div className="h-full min-h-0 min-w-0 overflow-hidden">
                    <DeviceAutomationsPanel
                      deviceId={device.id}
                      active={activePrimaryTab === "manage" && activeManageTab === "automations"}
                      className="h-full"
                    />
                  </div>
                </AnimatedTabPanel>
              </TabsContent>
            </Tabs>
          </AnimatedTabPanel>
        </TabsContent>

        <TabsContent value="activity" forceMount className="mt-3 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
          <AnimatedTabPanel active={activePrimaryTab === "activity"} persistent className="overflow-hidden">
            <div className="grid h-full min-h-0 min-w-0 gap-4 xl:grid-cols-2">
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
          <AnimatedTabPanel active={activePrimaryTab === "settings"} persistent className="overflow-auto">
            <div className="h-full min-h-0 min-w-0 overflow-auto">
              <DeviceSettingsPanel deviceId={device.id} />
            </div>
          </AnimatedTabPanel>
        </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
