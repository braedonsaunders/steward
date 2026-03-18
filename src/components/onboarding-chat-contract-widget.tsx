"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AccessMethod, DeviceProfileBinding, OnboardingDraft, WorkloadCategory } from "@/lib/state/types";
import type {
  OnboardingSynthesis,
} from "@/lib/adoption/conversation";

type Criticality = "low" | "medium" | "high";
type DesiredState = "running" | "stopped";

interface AdoptionSnapshot {
  run: {
    status: string;
    stage: string;
    summary?: string;
  } | null;
  profiles: DeviceProfileBinding[];
  accessMethods: AccessMethod[];
  draft: OnboardingDraft | null;
}

interface ProposalPayload {
  synthesis: OnboardingSynthesis | null;
  source: "generated" | "stored" | "none";
}

interface ResponsibilityRow {
  id: string;
  workloadKey: string;
  displayName: string;
  category: WorkloadCategory;
  criticality: Criticality;
  summary: string;
  included: boolean;
}

interface AssuranceRow {
  id: string;
  assuranceKey: string;
  displayName: string;
  workloadKey: string;
  criticality: Criticality;
  desiredState: DesiredState;
  checkIntervalSec: number;
  monitorType: string;
  requiredProtocols: string[];
  rationale: string;
  included: boolean;
}

const WORKLOAD_CATEGORIES: WorkloadCategory[] = [
  "application",
  "platform",
  "data",
  "network",
  "perimeter",
  "storage",
  "telemetry",
  "background",
  "unknown",
];

const CRITICALITIES: Criticality[] = ["low", "medium", "high"];
const DESIRED_STATES: DesiredState[] = ["running", "stopped"];
const INTERVAL_OPTIONS = [60, 120, 300, 600, 900, 1800, 3600];

function readSelectedProfileIds(snapshot: AdoptionSnapshot | null): string[] {
  if (snapshot?.draft?.selectedProfileIds?.length) {
    return snapshot.draft.selectedProfileIds;
  }
  return (snapshot?.profiles ?? [])
    .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
    .map((profile) => profile.profileId);
}

function readSelectedAccessMethodKeys(snapshot: AdoptionSnapshot | null): string[] {
  if (snapshot?.draft?.selectedAccessMethodKeys?.length) {
    return snapshot.draft.selectedAccessMethodKeys;
  }
  return (snapshot?.accessMethods ?? [])
    .filter((method) => method.selected)
    .map((method) => method.key);
}

function buildResponsibilityRows(synthesis: OnboardingSynthesis | null): ResponsibilityRow[] {
  const rawResponsibilities = Array.isArray(synthesis?.responsibilities)
    ? synthesis.responsibilities as Array<OnboardingSynthesis["responsibilities"][number] | string>
    : [];

  return rawResponsibilities.flatMap((responsibility, idx) => {
    if (typeof responsibility === "string") {
      const label = responsibility.trim();
      if (!label) {
        return [];
      }
      const workloadKey = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      return [{
        id: `${workloadKey || "responsibility"}:${idx}`,
        workloadKey: workloadKey || `responsibility_${idx + 1}`,
        displayName: label,
        category: "unknown" as WorkloadCategory,
        criticality: "medium" as Criticality,
        summary: "Imported from a previously saved onboarding proposal.",
        included: true,
      }];
    }

    return [{
      id: responsibility.id,
      workloadKey: responsibility.workloadKey,
      displayName: responsibility.displayName,
      category: responsibility.category,
      criticality: responsibility.criticality,
      summary: responsibility.summary,
      included: true,
    }];
  });
}

function buildAssuranceRows(
  synthesis: OnboardingSynthesis | null,
  responsibilities: ResponsibilityRow[],
): AssuranceRow[] {
  const responsibilityKeys = new Set(responsibilities.map((responsibility) => responsibility.workloadKey.toLowerCase()));
  return (synthesis?.assurances ?? []).map((assurance) => ({
    id: assurance.id,
    assuranceKey: assurance.assuranceKey,
    displayName: assurance.displayName,
    workloadKey: responsibilityKeys.has((assurance.serviceKey ?? assurance.assuranceKey).toLowerCase())
      ? (assurance.serviceKey ?? assurance.assuranceKey)
      : "__device__",
    criticality: assurance.criticality,
    desiredState: "running",
    checkIntervalSec: assurance.checkIntervalSec,
    monitorType: assurance.monitorType,
    requiredProtocols: assurance.requiredProtocols,
    rationale: assurance.rationale,
    included: true,
  }));
}

export function OnboardingChatContractWidget({
  deviceId,
  active = true,
  lastAssistantMessageId,
  className,
}: {
  deviceId: string;
  active?: boolean;
  lastAssistantMessageId?: string;
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [synthesis, setSynthesis] = useState<OnboardingSynthesis | null>(null);
  const [responsibilities, setResponsibilities] = useState<ResponsibilityRow[]>([]);
  const [assurances, setAssurances] = useState<AssuranceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const lastProposalRefreshIdRef = useRef<string | undefined>(undefined);

  const load = useCallback(async (options?: { refreshProposal?: boolean; silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const proposalSuffix = options?.refreshProposal ? "?refresh=1" : "";
      const [nextSnapshot, proposal] = await Promise.all([
        fetchClientJson<AdoptionSnapshot>(`/api/devices/${deviceId}/adoption`),
        fetchClientJson<ProposalPayload>(`/api/devices/${deviceId}/onboarding/proposal${proposalSuffix}`),
      ]);
      setSnapshot(nextSnapshot);
      setSynthesis(proposal.synthesis);
      const nextResponsibilities = buildResponsibilityRows(proposal.synthesis);
      setResponsibilities(nextResponsibilities);
      setAssurances(buildAssuranceRows(proposal.synthesis, nextResponsibilities));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load onboarding proposal");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setSnapshot(null);
    setSynthesis(null);
    setResponsibilities([]);
    setAssurances([]);
    setError(null);
    setStatusMessage(null);
    lastProposalRefreshIdRef.current = undefined;
    if (active) {
      void load();
    }
  }, [active, deviceId, load]);

  useEffect(() => {
    if (!active || !lastAssistantMessageId) {
      return;
    }
    if (lastProposalRefreshIdRef.current === lastAssistantMessageId) {
      return;
    }
    lastProposalRefreshIdRef.current = lastAssistantMessageId;
    void load({ refreshProposal: true, silent: true });
  }, [active, lastAssistantMessageId, load]);

  const enabledResponsibilities = useMemo(
    () => responsibilities.filter((responsibility) => responsibility.included),
    [responsibilities],
  );

  useEffect(() => {
    const enabledKeys = new Set(enabledResponsibilities.map((responsibility) => responsibility.workloadKey));
    setAssurances((current) => current.map((assurance) => (
      assurance.workloadKey === "__device__" || enabledKeys.has(assurance.workloadKey)
        ? assurance
        : { ...assurance, workloadKey: "__device__" }
    )));
  }, [enabledResponsibilities]);

  const canCommit = useMemo(() => {
    if (snapshot?.run?.status === "completed") {
      return false;
    }
    const selectedProfiles = readSelectedProfileIds(snapshot);
    return selectedProfiles.length > 0 || (snapshot?.profiles.length ?? 0) === 0;
  }, [snapshot]);

  const commitOnboarding = useCallback(async () => {
    setCommitting(true);
    setError(null);
    setStatusMessage(null);
    try {
      const selectedProfileIds = readSelectedProfileIds(snapshot);
      const selectedAccessMethodKeys = readSelectedAccessMethodKeys(snapshot);
      const includedResponsibilities = responsibilities
        .filter((responsibility) => responsibility.included)
        .map((responsibility) => ({
          workloadKey: responsibility.workloadKey,
          displayName: responsibility.displayName,
          category: responsibility.category,
          criticality: responsibility.criticality,
          summary: responsibility.summary,
        }));
      const includedAssurances = assurances
        .filter((assurance) => assurance.included)
        .map((assurance) => ({
          assuranceKey: assurance.assuranceKey,
          workloadKey: assurance.workloadKey === "__device__" ? undefined : assurance.workloadKey,
          displayName: assurance.displayName,
          criticality: assurance.criticality,
          desiredState: assurance.desiredState,
          checkIntervalSec: assurance.checkIntervalSec,
          monitorType: assurance.monitorType || undefined,
          requiredProtocols: assurance.requiredProtocols,
          rationale: assurance.rationale,
        }));

      await fetchClientJson(`/api/devices/${deviceId}/onboarding/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: synthesis?.summary ?? snapshot?.draft?.summary,
          selectedProfileIds,
          selectedAccessMethodKeys,
          workloads: includedResponsibilities,
          assurances: includedAssurances,
          residualUnknowns: snapshot?.draft?.residualUnknowns ?? [],
        }),
      });

      setStatusMessage("Onboarding committed.");
      await load({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to commit onboarding");
    } finally {
      setCommitting(false);
    }
  }, [assurances, deviceId, load, responsibilities, snapshot, synthesis?.summary]);

  const updateResponsibility = useCallback((id: string, updater: (item: ResponsibilityRow) => ResponsibilityRow) => {
    setResponsibilities((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }, []);

  const updateAssurance = useCallback((id: string, updater: (item: AssuranceRow) => AssuranceRow) => {
    setAssurances((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }, []);

  const proposalCount = responsibilities.length + assurances.length;

  return (
    <Card className={cn("border-primary/20 bg-card/88", className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Onboarding Contract Review</CardTitle>
            <CardDescription>
              Review the proposed responsibilities and assurances here, then commit onboarding in one step.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {snapshot?.run?.status ? (
              <Badge variant={snapshot.run.status === "completed" ? "default" : "outline"}>
                {snapshot.run.status}
              </Badge>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-[11px]"
              onClick={() => void load({ refreshProposal: true, silent: true })}
              disabled={loading || refreshing || committing}
            >
              {refreshing ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <RefreshCw className="mr-1.5 size-3" />}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading onboarding proposal
          </div>
        ) : null}

        {!loading && error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {!loading && !error && proposalCount === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground">
            Steward has not produced a responsibility or assurance proposal yet. Continue the onboarding chat and refresh once the device purpose is clearer.
          </div>
        ) : null}

        {!loading && !error && proposalCount > 0 ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border bg-background/55 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Responsibilities</p>
                <p className="text-lg font-semibold tabular-nums">{responsibilities.length}</p>
              </div>
              <div className="rounded-md border bg-background/55 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Assurances</p>
                <p className="text-lg font-semibold tabular-nums">{assurances.length}</p>
              </div>
              <div className="rounded-md border bg-background/55 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Profile Selection</p>
                <p className="text-lg font-semibold tabular-nums">{readSelectedProfileIds(snapshot).length}</p>
              </div>
            </div>

            {synthesis?.summary ? (
              <p className="rounded-md border bg-background/55 px-3 py-2 text-xs text-muted-foreground">
                {synthesis.summary}
              </p>
            ) : null}

            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Responsibilities</p>
                <p className="text-xs text-muted-foreground">
                  Toggle the outcomes Steward should own, then adjust category or criticality where needed.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Use</TableHead>
                    <TableHead>Responsibility</TableHead>
                    <TableHead className="w-40">Category</TableHead>
                    <TableHead className="w-32">Criticality</TableHead>
                    <TableHead>Summary</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {responsibilities.map((responsibility) => (
                    <TableRow key={responsibility.id}>
                      <TableCell>
                        <Switch
                          size="sm"
                          checked={responsibility.included}
                          onCheckedChange={(checked) => updateResponsibility(responsibility.id, (item) => ({ ...item, included: checked }))}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{responsibility.displayName}</TableCell>
                      <TableCell>
                        <Select
                          value={responsibility.category}
                          onValueChange={(value) => updateResponsibility(
                            responsibility.id,
                            (item) => ({ ...item, category: value as WorkloadCategory }),
                          )}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WORKLOAD_CATEGORIES.map((category) => (
                              <SelectItem key={category} value={category}>
                                {category.replace(/_/g, " ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={responsibility.criticality}
                          onValueChange={(value) => updateResponsibility(
                            responsibility.id,
                            (item) => ({ ...item, criticality: value as Criticality }),
                          )}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CRITICALITIES.map((criticality) => (
                              <SelectItem key={criticality} value={criticality}>
                                {criticality}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{responsibility.summary}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium">Assurances</p>
                <p className="text-xs text-muted-foreground">
                  Confirm which checks Steward should keep running and what each check should attach to.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Use</TableHead>
                    <TableHead>Assurance</TableHead>
                    <TableHead className="w-44">Linked Responsibility</TableHead>
                    <TableHead className="w-28">Interval</TableHead>
                    <TableHead className="w-28">Target</TableHead>
                    <TableHead className="w-28">Criticality</TableHead>
                    <TableHead>Protocols</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assurances.map((assurance) => (
                    <TableRow key={assurance.id}>
                      <TableCell>
                        <Switch
                          size="sm"
                          checked={assurance.included}
                          onCheckedChange={(checked) => updateAssurance(assurance.id, (item) => ({ ...item, included: checked }))}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <p className="font-medium">{assurance.displayName}</p>
                          <p className="text-[11px] text-muted-foreground">{assurance.rationale}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={assurance.workloadKey}
                          onValueChange={(value) => updateAssurance(assurance.id, (item) => ({ ...item, workloadKey: value }))}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__device__">Device-wide</SelectItem>
                            {enabledResponsibilities.map((responsibility) => (
                              <SelectItem key={responsibility.workloadKey} value={responsibility.workloadKey}>
                                {responsibility.displayName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={String(assurance.checkIntervalSec)}
                          onValueChange={(value) => updateAssurance(
                            assurance.id,
                            (item) => ({ ...item, checkIntervalSec: Number(value) }),
                          )}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {INTERVAL_OPTIONS.map((interval) => (
                              <SelectItem key={interval} value={String(interval)}>
                                {interval}s
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={assurance.desiredState}
                          onValueChange={(value) => updateAssurance(
                            assurance.id,
                            (item) => ({ ...item, desiredState: value as DesiredState }),
                          )}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DESIRED_STATES.map((desiredState) => (
                              <SelectItem key={desiredState} value={desiredState}>
                                {desiredState}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={assurance.criticality}
                          onValueChange={(value) => updateAssurance(
                            assurance.id,
                            (item) => ({ ...item, criticality: value as Criticality }),
                          )}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CRITICALITIES.map((criticality) => (
                              <SelectItem key={criticality} value={criticality}>
                                {criticality}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {assurance.requiredProtocols.length > 0 ? assurance.requiredProtocols.join(", ") : "none"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {!canCommit ? (
              <p className="rounded-md border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-100">
                Select at least one profile in onboarding before committing this contract.
              </p>
            ) : null}

            {statusMessage ? (
              <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
                {statusMessage}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/55 px-3 py-3">
              <div className="text-xs text-muted-foreground">
                Committing here applies the selected responsibilities and assurances and marks onboarding complete.
              </div>
              <Button
                type="button"
                onClick={() => void commitOnboarding()}
                disabled={committing || refreshing || !canCommit}
              >
                {committing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}
                Save and Complete
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
