"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type {
  AdoptionQuestion,
  AdoptionRun,
  Assurance,
  AssuranceRun,
  DeviceCredential,
  DeviceFinding,
  Workload,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  questions: AdoptionQuestion[];
  unresolvedRequiredQuestions: number;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  workloads: Workload[];
  assurances: Assurance[];
  assuranceRuns: AssuranceRun[];
}

interface FindingsPayload {
  findings: DeviceFinding[];
}

function statusVariant(
  status: AdoptionRun["status"] | "idle",
): "default" | "destructive" | "secondary" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "awaiting_user") return "secondary";
  return "outline";
}

function assuranceRunVariant(
  status: AssuranceRun["status"] | "unknown",
): "default" | "destructive" | "secondary" | "outline" {
  if (status === "pass") return "default";
  if (status === "fail") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

function readString(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function DeviceWorkloadsPanel({ deviceId, className }: { deviceId: string; className?: string }) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [findings, setFindings] = useState<DeviceFinding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [snapshotRes, findingsRes] = await Promise.all([
        fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken()),
        fetch(`/api/devices/${deviceId}/findings`, withClientApiToken()),
      ]);
      const snapshotData = (await snapshotRes.json()) as AdoptionSnapshot | { error?: string };
      if (!snapshotRes.ok) {
        throw new Error((snapshotData as { error?: string }).error ?? "Failed to load workload model");
      }
      setSnapshot(snapshotData as AdoptionSnapshot);

      if (findingsRes.ok) {
        const findingsData = (await findingsRes.json()) as FindingsPayload;
        setFindings(Array.isArray(findingsData.findings) ? findingsData.findings : []);
      } else {
        setFindings([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workload model");
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runByAssuranceId = useMemo(
    () => new Map((snapshot?.assuranceRuns ?? []).map((run) => [run.assuranceId, run])),
    [snapshot?.assuranceRuns],
  );

  const assurancesByWorkload = useMemo(() => {
    const grouped = new Map<string, Assurance[]>();
    for (const assurance of snapshot?.assurances ?? []) {
      const key = assurance.workloadId ?? "__unassigned__";
      const existing = grouped.get(key) ?? [];
      existing.push(assurance);
      grouped.set(key, existing);
    }
    for (const items of grouped.values()) {
      items.sort((a, b) => {
        const criticalityRank = (value: Assurance["criticality"]): number =>
          value === "high" ? 0 : value === "medium" ? 1 : 2;
        return criticalityRank(a.criticality) - criticalityRank(b.criticality);
      });
    }
    return grouped;
  }, [snapshot?.assurances]);

  const openConcerns = useMemo(
    () => findings.filter((finding) => finding.status === "open" && [
      "assurance",
      "assurance_pending",
      "service_contract",
      "service_contract_pending",
      "missing_credentials",
    ].includes(finding.findingType)),
    [findings],
  );

  const proposedWorkloads = useMemo(() => {
    const profile = snapshot?.run?.profileJson;
    const value = profile?.proposedWorkloads;
    return Array.isArray(value) ? value : [];
  }, [snapshot?.run]);

  const proposedAssurances = useMemo(() => {
    const profile = snapshot?.run?.profileJson;
    const value = profile?.proposedAssurances ?? profile?.proposedContracts;
    return Array.isArray(value) ? value : [];
  }, [snapshot?.run]);

  return (
    <Card className={cn("bg-card/85 flex min-h-0 flex-col", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Workloads</CardTitle>
            <CardDescription>Responsibilities Steward understands and the assurances it enforces</CardDescription>
          </div>
          <Badge variant={statusVariant(snapshot?.run?.status ?? "idle")}>{snapshot?.run?.status ?? "idle"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        <div className="grid gap-2 sm:grid-cols-4">
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Workloads</p>
            <p className="text-lg font-semibold tabular-nums">{snapshot?.workloads.length ?? 0}</p>
          </div>
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Assurances</p>
            <p className="text-lg font-semibold tabular-nums">{snapshot?.assurances.length ?? 0}</p>
          </div>
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Concerns</p>
            <p className="text-lg font-semibold tabular-nums">{openConcerns.length}</p>
          </div>
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Draft Proposals</p>
            <p className="text-lg font-semibold tabular-nums">{Math.max(proposedWorkloads.length, proposedAssurances.length)}</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Use the Chat tab to refine responsibilities, then approve the resulting workload and assurance model.
        </p>

        <div className="space-y-2">
          <Label className="text-xs">Active Workload Model</Label>
          {(snapshot?.workloads.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">
              No workloads have been committed yet. Continue onboarding in Chat to convert observed endpoints into managed responsibilities.
            </p>
          ) : (
            <div className="space-y-2">
              {snapshot?.workloads.map((workload) => {
                const workloadAssurances = assurancesByWorkload.get(workload.id) ?? [];
                return (
                  <div key={workload.id} className="rounded-md border bg-background/45 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{workload.displayName}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {workload.category.replace(/_/g, " ")} workload
                        </p>
                      </div>
                      <Badge variant="outline">{workload.criticality}</Badge>
                    </div>
                    {workload.summary ? (
                      <p className="mt-2 text-xs text-muted-foreground">{workload.summary}</p>
                    ) : null}
                    <div className="mt-3 space-y-2">
                      {workloadAssurances.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No assurances attached yet.</p>
                      ) : (
                        workloadAssurances.map((assurance) => {
                          const latestRun = runByAssuranceId.get(assurance.id);
                          const rationale = assurance.rationale ?? readString(assurance.configJson, "rationale") ?? readString(assurance.policyJson, "reason");
                          const monitorType = assurance.monitorType ?? readString(assurance.configJson, "monitorType") ?? readString(assurance.policyJson, "monitorType");
                          return (
                            <div key={assurance.id} className="rounded-md border bg-background/70 p-2.5 text-xs">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="font-medium">{assurance.displayName}</p>
                                  <p className="text-muted-foreground">
                                    Every {Math.max(1, Math.floor(assurance.checkIntervalSec))}s
                                    {monitorType ? ` · ${monitorType.replace(/_/g, " ")}` : ""}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <Badge variant="outline">{assurance.criticality}</Badge>
                                  <Badge variant={assuranceRunVariant(latestRun?.status ?? "unknown")}>
                                    {latestRun?.status ?? "unknown"}
                                  </Badge>
                                </div>
                              </div>
                              {rationale ? (
                                <p className="mt-1 text-muted-foreground">{rationale}</p>
                              ) : null}
                              {(assurance.requiredProtocols ?? []).length > 0 ? (
                                <p className="mt-1 text-muted-foreground">
                                  Needs access: {(assurance.requiredProtocols ?? []).join(", ")}
                                </p>
                              ) : null}
                              {latestRun ? (
                                <p className="mt-1 text-muted-foreground">
                                  Last evaluated: {new Date(latestRun.evaluatedAt).toLocaleString()}
                                </p>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {proposedWorkloads.length > 0 || proposedAssurances.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-xs">
              Draft Onboarding Proposals ({proposedWorkloads.length} workloads, {proposedAssurances.length} assurances)
            </Label>
            {proposedWorkloads.length > 0 ? (
              <div className="space-y-1.5">
                {proposedWorkloads.map((proposal, idx) => (
                  <div key={`${proposal.id ?? proposal.workloadKey ?? idx}:workload`} className="rounded-md border px-2.5 py-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{String(proposal.displayName ?? proposal.workloadKey ?? "Draft workload")}</p>
                        <p className="text-muted-foreground">
                          {String(proposal.category ?? "unknown").replace(/_/g, " ")} workload
                        </p>
                      </div>
                      <Badge variant="outline">{String(proposal.criticality ?? "medium")}</Badge>
                    </div>
                    {typeof proposal.summary === "string" ? (
                      <p className="mt-1 text-muted-foreground">{proposal.summary}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="space-y-1.5">
              {proposedAssurances.map((proposal, idx) => (
                <div key={`${proposal.id ?? proposal.serviceKey ?? idx}`} className="rounded-md border px-2.5 py-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{String(proposal.displayName ?? proposal.serviceKey ?? "Draft assurance")}</p>
                      <p className="text-muted-foreground">
                        {String(proposal.monitorType ?? "service_presence").replace(/_/g, " ")}
                        {proposal.checkIntervalSec ? ` · every ${proposal.checkIntervalSec}s` : ""}
                      </p>
                    </div>
                    <Badge variant="outline">{String(proposal.criticality ?? "medium")}</Badge>
                  </div>
                  {typeof proposal.rationale === "string" ? (
                    <p className="mt-1 text-muted-foreground">{proposal.rationale}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {snapshot?.unresolvedRequiredQuestions ? (
          <p className="rounded-md border border-amber-300/60 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-100">
            Onboarding still has {snapshot.unresolvedRequiredQuestions} required question{snapshot.unresolvedRequiredQuestions === 1 ? "" : "s"} pending.
          </p>
        ) : null}

        {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

export const DeviceContractsPanel = DeviceWorkloadsPanel;
