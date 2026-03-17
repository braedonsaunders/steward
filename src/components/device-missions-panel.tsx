"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Target } from "lucide-react";
import Link from "next/link";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface MissionPanelItem {
  id: string;
  title: string;
  summary: string;
  kind: string;
  status: "active" | "paused" | "completed" | "archived";
  priority: "low" | "medium" | "high";
  subagent?: {
    name: string;
  };
  lastSummary?: string;
  openInvestigations: Array<{ id: string }>;
  plan?: {
    summary: string;
    status: "active" | "blocked" | "completed";
    checkpointsJson: string[];
  };
  delegations: Array<{
    id: string;
    title: string;
    status: "open" | "accepted" | "completed" | "dismissed";
    toSubagentId: string;
  }>;
}

interface DeviceAutonomyPayload {
  deviceId: string;
  deviceMissionIds: string[];
  matchedMissionIds: string[];
  workloadMissionIdsByWorkloadId: Record<string, string[]>;
  assuranceMissionIdsByAssuranceId: Record<string, string[]>;
  missions: MissionPanelItem[];
}

function scopeSourceLabel(payload: DeviceAutonomyPayload, missionId: string): string {
  if (payload.deviceMissionIds.includes(missionId)) {
    return "explicit";
  }
  if (payload.matchedMissionIds.includes(missionId)) {
    return "selector";
  }
  return "linked";
}

export function DeviceMissionsPanel({
  deviceId,
  active = true,
  className,
}: {
  deviceId: string;
  active?: boolean;
  className?: string;
}) {
  const [payload, setPayload] = useState<DeviceAutonomyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const next = await fetchClientJson<DeviceAutonomyPayload>(`/api/devices/${deviceId}/autonomy`);
      setPayload(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load mission control");
    } finally {
      setHasLoaded(true);
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [deviceId]);

  useEffect(() => {
    setPayload(null);
    setLoading(true);
    setHasLoaded(false);
    setError(null);
  }, [deviceId]);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void refresh();
  }, [active, hasLoaded, refresh]);

  useEffect(() => {
    if (!active || !hasLoaded) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [active, hasLoaded, refresh]);

  const activeMissions = useMemo(
    () => (payload?.missions ?? []).filter((mission) => mission.status === "active"),
    [payload?.missions],
  );
  const openDelegations = useMemo(
    () => (payload?.missions ?? []).reduce((sum, mission) => sum + mission.delegations.filter((delegation) => delegation.status === "open" || delegation.status === "accepted").length, 0),
    [payload?.missions],
  );
  const openInvestigations = useMemo(
    () => (payload?.missions ?? []).reduce((sum, mission) => sum + mission.openInvestigations.length, 0),
    [payload?.missions],
  );

  return (
    <Card className={cn("flex h-full min-h-0 flex-col bg-card/85", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Target className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Mission Control</CardTitle>
        </div>
        <CardDescription>
          Which durable missions currently own this device, how they matched scope, and what follow-up is still open.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 px-3 py-4 text-sm text-destructive">{error}</div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Active missions</p>
                <p className="mt-1 text-2xl font-semibold">{activeMissions.length}</p>
              </div>
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Open investigations</p>
                <p className="mt-1 text-2xl font-semibold">{openInvestigations}</p>
              </div>
              <div className="rounded-lg border border-border/70 p-3">
                <p className="text-xs text-muted-foreground">Open delegations</p>
                <p className="mt-1 text-2xl font-semibold">{openDelegations}</p>
              </div>
            </div>

            {(payload?.missions ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                No missions currently cover this device. Configure scope from the Missions page if Steward should own it explicitly.
              </div>
            ) : (
              <div className="space-y-3">
                {(payload?.missions ?? []).map((mission) => {
                  const scopeSource = payload ? scopeSourceLabel(payload, mission.id) : "linked";
                  const openDelegationCount = mission.delegations.filter((delegation) => delegation.status === "open" || delegation.status === "accepted").length;
                  return (
                    <div key={mission.id} className="rounded-xl border border-border/70 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{mission.title}</p>
                            <Badge variant="outline">{mission.kind}</Badge>
                            <Badge variant={mission.priority === "high" ? "destructive" : mission.priority === "medium" ? "secondary" : "outline"}>
                              {mission.priority}
                            </Badge>
                            <Badge variant={scopeSource === "explicit" ? "default" : "outline"}>{scopeSource}</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{mission.summary}</p>
                          <p className="text-xs text-muted-foreground">
                            Owner: {mission.subagent?.name ?? "Unassigned"} · Status: {mission.status}
                          </p>
                        </div>
                        <Link href="/missions" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          Edit mission
                          <ArrowRight className="size-3.5" />
                        </Link>
                      </div>

                      <div className="mt-3 grid gap-3 lg:grid-cols-[1.3fr_0.7fr]">
                        <div className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current plan</p>
                          <p className="text-sm text-foreground">{mission.plan?.summary ?? mission.lastSummary ?? "No mission plan written yet."}</p>
                          {mission.plan?.checkpointsJson?.length ? (
                            <div className="flex flex-wrap gap-1.5">
                              {mission.plan.checkpointsJson.slice(0, 4).map((checkpoint) => (
                                <Badge key={checkpoint} variant="outline" className="max-w-full truncate">{checkpoint}</Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Follow-up</p>
                          <p className="text-sm text-foreground">
                            {mission.openInvestigations.length} investigation{mission.openInvestigations.length === 1 ? "" : "s"} · {openDelegationCount} delegation{openDelegationCount === 1 ? "" : "s"}
                          </p>
                          {openDelegationCount > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {mission.delegations
                                .filter((delegation) => delegation.status === "open" || delegation.status === "accepted")
                                .slice(0, 3)
                                .map((delegation) => (
                                  <Badge key={delegation.id} variant="secondary">{delegation.title}</Badge>
                                ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
