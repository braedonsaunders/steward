"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  AccessMethod,
  AdoptionRun,
  Assurance,
  AssuranceRun,
  DeviceFinding,
  DeviceProfileBinding,
  OnboardingDraft,
  OnboardingDraftAssurance,
  OnboardingDraftWorkload,
  Workload,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  unresolvedRequiredQuestions: number;
  accessMethods: AccessMethod[];
  profiles: DeviceProfileBinding[];
  workloads: Workload[];
  assurances: Assurance[];
  assuranceRuns: AssuranceRun[];
  draft: OnboardingDraft | null;
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

const WORKLOAD_CATEGORY_OPTIONS: Workload["category"][] = [
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

const WORKLOAD_CRITICALITY_OPTIONS: Workload["criticality"][] = ["low", "medium", "high"];
const ASSURANCE_CRITICALITY_OPTIONS: Assurance["criticality"][] = ["low", "medium", "high"];
const ASSURANCE_DESIRED_STATE_OPTIONS: Assurance["desiredState"][] = ["running", "stopped"];

function slugifyDraftKey(value: string, fallbackPrefix: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized.length > 0 ? normalized : `${fallbackPrefix}-${Date.now()}`;
}

function uniqueDraftKey(existingKeys: Iterable<string>, requested: string): string {
  const used = new Set(Array.from(existingKeys, (key) => key.trim().toLowerCase()).filter(Boolean));
  if (!used.has(requested.toLowerCase())) {
    return requested;
  }
  let counter = 2;
  while (used.has(`${requested}-${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${requested}-${counter}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function parseMultilineList(value: string): string[] {
  return dedupeStrings(value.split("\n"));
}

export function DeviceWorkloadsPanel({ deviceId, className }: { deviceId: string; className?: string }) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [findings, setFindings] = useState<DeviceFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [workloadDialogOpen, setWorkloadDialogOpen] = useState(false);
  const [editingWorkloadId, setEditingWorkloadId] = useState<string | null>(null);
  const [workloadDisplayName, setWorkloadDisplayName] = useState("");
  const [workloadCategory, setWorkloadCategory] = useState<Workload["category"]>("unknown");
  const [workloadCriticality, setWorkloadCriticality] = useState<Workload["criticality"]>("medium");
  const [workloadSummary, setWorkloadSummary] = useState("");
  const [workloadSaving, setWorkloadSaving] = useState(false);
  const [deletingWorkloadId, setDeletingWorkloadId] = useState<string | null>(null);

  const [assuranceDialogOpen, setAssuranceDialogOpen] = useState(false);
  const [editingAssuranceId, setEditingAssuranceId] = useState<string | null>(null);
  const [assuranceWorkloadId, setAssuranceWorkloadId] = useState<string>("__none__");
  const [assuranceDisplayName, setAssuranceDisplayName] = useState("");
  const [assuranceCriticality, setAssuranceCriticality] = useState<Assurance["criticality"]>("medium");
  const [assuranceDesiredState, setAssuranceDesiredState] = useState<Assurance["desiredState"]>("running");
  const [assuranceCheckIntervalSec, setAssuranceCheckIntervalSec] = useState("120");
  const [assuranceMonitorType, setAssuranceMonitorType] = useState("");
  const [assuranceRequiredProtocols, setAssuranceRequiredProtocols] = useState("");
  const [assuranceRationale, setAssuranceRationale] = useState("");
  const [assuranceSaving, setAssuranceSaving] = useState(false);
  const [deletingAssuranceId, setDeletingAssuranceId] = useState<string | null>(null);

  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [draftSummary, setDraftSummary] = useState("");
  const [draftNextActions, setDraftNextActions] = useState("");
  const [draftUnresolvedQuestions, setDraftUnresolvedQuestions] = useState("");
  const [draftResidualUnknowns, setDraftResidualUnknowns] = useState("");
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftResetting, setDraftResetting] = useState(false);
  const [draftDeleting, setDraftDeleting] = useState(false);

  const [draftWorkloadDialogOpen, setDraftWorkloadDialogOpen] = useState(false);
  const [editingDraftWorkloadKey, setEditingDraftWorkloadKey] = useState<string | null>(null);
  const [draftWorkloadDisplayName, setDraftWorkloadDisplayName] = useState("");
  const [draftWorkloadCategory, setDraftWorkloadCategory] = useState<Workload["category"]>("unknown");
  const [draftWorkloadCriticality, setDraftWorkloadCriticality] = useState<Workload["criticality"]>("medium");
  const [draftWorkloadSummary, setDraftWorkloadSummary] = useState("");
  const [draftWorkloadSaving, setDraftWorkloadSaving] = useState(false);
  const [deletingDraftWorkloadKey, setDeletingDraftWorkloadKey] = useState<string | null>(null);

  const [draftAssuranceDialogOpen, setDraftAssuranceDialogOpen] = useState(false);
  const [editingDraftAssuranceKey, setEditingDraftAssuranceKey] = useState<string | null>(null);
  const [draftAssuranceWorkloadKey, setDraftAssuranceWorkloadKey] = useState<string>("__none__");
  const [draftAssuranceDisplayName, setDraftAssuranceDisplayName] = useState("");
  const [draftAssuranceCriticality, setDraftAssuranceCriticality] = useState<Assurance["criticality"]>("medium");
  const [draftAssuranceDesiredState, setDraftAssuranceDesiredState] = useState<Assurance["desiredState"]>("running");
  const [draftAssuranceCheckIntervalSec, setDraftAssuranceCheckIntervalSec] = useState("120");
  const [draftAssuranceMonitorType, setDraftAssuranceMonitorType] = useState("");
  const [draftAssuranceRequiredProtocols, setDraftAssuranceRequiredProtocols] = useState("");
  const [draftAssuranceRationale, setDraftAssuranceRationale] = useState("");
  const [draftAssuranceSaving, setDraftAssuranceSaving] = useState(false);
  const [deletingDraftAssuranceKey, setDeletingDraftAssuranceKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [snapshotRes, findingsRes] = await Promise.all([
        fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken()),
        fetch(`/api/devices/${deviceId}/findings`, withClientApiToken()),
      ]);
      const snapshotData = (await snapshotRes.json()) as AdoptionSnapshot | { error?: string };
      if (!snapshotRes.ok) {
        throw new Error((snapshotData as { error?: string }).error ?? "Failed to load Steward contract");
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
      setError(err instanceof Error ? err.message : "Failed to load Steward contract");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetWorkloadForm = useCallback(() => {
    setEditingWorkloadId(null);
    setWorkloadDisplayName("");
    setWorkloadCategory("unknown");
    setWorkloadCriticality("medium");
    setWorkloadSummary("");
  }, []);

  const resetAssuranceForm = useCallback(() => {
    setEditingAssuranceId(null);
    setAssuranceWorkloadId("__none__");
    setAssuranceDisplayName("");
    setAssuranceCriticality("medium");
    setAssuranceDesiredState("running");
    setAssuranceCheckIntervalSec("120");
    setAssuranceMonitorType("");
    setAssuranceRequiredProtocols("");
    setAssuranceRationale("");
  }, []);

  const resetDraftForm = useCallback(() => {
    setDraftSummary("");
    setDraftNextActions("");
    setDraftUnresolvedQuestions("");
    setDraftResidualUnknowns("");
  }, []);

  const resetDraftWorkloadForm = useCallback(() => {
    setEditingDraftWorkloadKey(null);
    setDraftWorkloadDisplayName("");
    setDraftWorkloadCategory("unknown");
    setDraftWorkloadCriticality("medium");
    setDraftWorkloadSummary("");
  }, []);

  const resetDraftAssuranceForm = useCallback(() => {
    setEditingDraftAssuranceKey(null);
    setDraftAssuranceWorkloadKey("__none__");
    setDraftAssuranceDisplayName("");
    setDraftAssuranceCriticality("medium");
    setDraftAssuranceDesiredState("running");
    setDraftAssuranceCheckIntervalSec("120");
    setDraftAssuranceMonitorType("");
    setDraftAssuranceRequiredProtocols("");
    setDraftAssuranceRationale("");
  }, []);

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

  const unassignedAssurances = useMemo(
    () => assurancesByWorkload.get("__unassigned__") ?? [],
    [assurancesByWorkload],
  );

  const committedWorkloadKeys = useMemo(
    () => new Set((snapshot?.workloads ?? []).map((workload) => workload.workloadKey.toLowerCase())),
    [snapshot?.workloads],
  );

  const committedAssuranceKeys = useMemo(
    () => new Set((snapshot?.assurances ?? []).map((assurance) => assurance.assuranceKey.toLowerCase())),
    [snapshot?.assurances],
  );

  const draftWorkloads = useMemo(() => {
    return (snapshot?.draft?.workloads ?? []).filter(
      (workload) => !committedWorkloadKeys.has(workload.workloadKey.toLowerCase()),
    );
  }, [committedWorkloadKeys, snapshot?.draft?.workloads]);

  const draftAssurances = useMemo(() => {
    return (snapshot?.draft?.assurances ?? []).filter(
      (assurance) => !committedAssuranceKeys.has(assurance.assuranceKey.toLowerCase()),
    );
  }, [committedAssuranceKeys, snapshot?.draft?.assurances]);

  const draftAssurancesByWorkloadKey = useMemo(() => {
    const grouped = new Map<string, OnboardingDraftAssurance[]>();
    for (const assurance of draftAssurances) {
      const key = assurance.workloadKey ?? "__unassigned__";
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
  }, [draftAssurances]);

  const unassignedDraftAssurances = useMemo(
    () => draftAssurancesByWorkloadKey.get("__unassigned__") ?? [],
    [draftAssurancesByWorkloadKey],
  );

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

  const openCreateWorkloadDialog = useCallback(() => {
    resetWorkloadForm();
    setWorkloadDialogOpen(true);
  }, [resetWorkloadForm]);

  const openEditWorkloadDialog = useCallback((workload: Workload) => {
    setEditingWorkloadId(workload.id);
    setWorkloadDisplayName(workload.displayName);
    setWorkloadCategory(workload.category);
    setWorkloadCriticality(workload.criticality);
    setWorkloadSummary(workload.summary ?? "");
    setWorkloadDialogOpen(true);
  }, []);

  const openCreateAssuranceDialog = useCallback((workloadId?: string) => {
    resetAssuranceForm();
    setAssuranceWorkloadId(workloadId ?? "__none__");
    setAssuranceDialogOpen(true);
  }, [resetAssuranceForm]);

  const openEditAssuranceDialog = useCallback((assurance: Assurance) => {
    setEditingAssuranceId(assurance.id);
    setAssuranceWorkloadId(assurance.workloadId ?? "__none__");
    setAssuranceDisplayName(assurance.displayName);
    setAssuranceCriticality(assurance.criticality);
    setAssuranceDesiredState(assurance.desiredState);
    setAssuranceCheckIntervalSec(String(Math.max(15, Math.floor(assurance.checkIntervalSec))));
    setAssuranceMonitorType(assurance.monitorType ?? "");
    setAssuranceRequiredProtocols((assurance.requiredProtocols ?? []).join(", "));
    setAssuranceRationale(assurance.rationale ?? "");
    setAssuranceDialogOpen(true);
  }, []);

  const persistDraftUpdate = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch(
      `/api/devices/${deviceId}/onboarding/draft`,
      withClientApiToken({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Failed to update onboarding draft");
    }
    await refresh();
    setError(null);
  }, [deviceId, refresh]);

  const openEditDraftDialog = useCallback(() => {
    if (!snapshot?.draft) {
      return;
    }
    setDraftSummary(snapshot.draft.summary ?? "");
    setDraftNextActions(snapshot.draft.nextActions.join("\n"));
    setDraftUnresolvedQuestions(snapshot.draft.unresolvedQuestions.join("\n"));
    setDraftResidualUnknowns(snapshot.draft.residualUnknowns.join("\n"));
    setDraftDialogOpen(true);
  }, [snapshot?.draft]);

  const openCreateDraftWorkloadDialog = useCallback(() => {
    resetDraftWorkloadForm();
    setDraftWorkloadDialogOpen(true);
  }, [resetDraftWorkloadForm]);

  const openEditDraftWorkloadDialog = useCallback((workload: OnboardingDraftWorkload) => {
    setEditingDraftWorkloadKey(workload.workloadKey);
    setDraftWorkloadDisplayName(workload.displayName);
    setDraftWorkloadCategory(workload.category ?? "unknown");
    setDraftWorkloadCriticality(workload.criticality);
    setDraftWorkloadSummary(workload.summary ?? "");
    setDraftWorkloadDialogOpen(true);
  }, []);

  const openCreateDraftAssuranceDialog = useCallback((workloadKey?: string) => {
    resetDraftAssuranceForm();
    setDraftAssuranceWorkloadKey(workloadKey ?? "__none__");
    setDraftAssuranceDialogOpen(true);
  }, [resetDraftAssuranceForm]);

  const openEditDraftAssuranceDialog = useCallback((assurance: OnboardingDraftAssurance) => {
    setEditingDraftAssuranceKey(assurance.assuranceKey);
    setDraftAssuranceWorkloadKey(assurance.workloadKey ?? "__none__");
    setDraftAssuranceDisplayName(assurance.displayName);
    setDraftAssuranceCriticality(assurance.criticality);
    setDraftAssuranceDesiredState(assurance.desiredState ?? "running");
    setDraftAssuranceCheckIntervalSec(String(Math.max(15, Math.floor(assurance.checkIntervalSec))));
    setDraftAssuranceMonitorType(assurance.monitorType ?? "");
    setDraftAssuranceRequiredProtocols((assurance.requiredProtocols ?? []).join(", "));
    setDraftAssuranceRationale(assurance.rationale ?? "");
    setDraftAssuranceDialogOpen(true);
  }, []);

  const submitWorkload = useCallback(async () => {
    if (!workloadDisplayName.trim()) {
      return;
    }

    setWorkloadSaving(true);
    try {
      const body = {
        displayName: workloadDisplayName.trim(),
        category: workloadCategory,
        criticality: workloadCriticality,
        summary: workloadSummary.trim() || null,
      };
      const endpoint = editingWorkloadId
        ? `/api/devices/${deviceId}/workloads/${editingWorkloadId}`
        : `/api/devices/${deviceId}/workloads`;
      const method = editingWorkloadId ? "PATCH" : "POST";

      const response = await fetch(
        endpoint,
        withClientApiToken({
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to save workload");
      }

      setWorkloadDialogOpen(false);
      resetWorkloadForm();
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save workload");
    } finally {
      setWorkloadSaving(false);
    }
  }, [
    deviceId,
    editingWorkloadId,
    refresh,
    resetWorkloadForm,
    workloadCategory,
    workloadCriticality,
    workloadDisplayName,
    workloadSummary,
  ]);

  const submitAssurance = useCallback(async () => {
    if (!assuranceDisplayName.trim()) {
      return;
    }

    const parsedInterval = Number.parseInt(assuranceCheckIntervalSec, 10);
    const checkIntervalSec = Number.isFinite(parsedInterval)
      ? Math.max(15, Math.min(3600, parsedInterval))
      : 120;
    const requiredProtocols = Array.from(new Set(
      assuranceRequiredProtocols
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ));

    setAssuranceSaving(true);
    try {
      const body = {
        displayName: assuranceDisplayName.trim(),
        workloadId: assuranceWorkloadId === "__none__" ? null : assuranceWorkloadId,
        criticality: assuranceCriticality,
        desiredState: assuranceDesiredState,
        checkIntervalSec,
        monitorType: assuranceMonitorType.trim() || null,
        requiredProtocols,
        rationale: assuranceRationale.trim() || null,
      };
      const endpoint = editingAssuranceId
        ? `/api/devices/${deviceId}/assurances/${editingAssuranceId}`
        : `/api/devices/${deviceId}/assurances`;
      const method = editingAssuranceId ? "PATCH" : "POST";

      const response = await fetch(
        endpoint,
        withClientApiToken({
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to save assurance");
      }

      setAssuranceDialogOpen(false);
      resetAssuranceForm();
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save assurance");
    } finally {
      setAssuranceSaving(false);
    }
  }, [
    assuranceCheckIntervalSec,
    assuranceCriticality,
    assuranceDesiredState,
    assuranceDisplayName,
    assuranceMonitorType,
    assuranceRationale,
    assuranceRequiredProtocols,
    assuranceWorkloadId,
    deviceId,
    editingAssuranceId,
    refresh,
    resetAssuranceForm,
  ]);

  const submitDraft = useCallback(async () => {
    if (!snapshot?.draft) {
      return;
    }

    setDraftSaving(true);
    try {
      await persistDraftUpdate({
        summary: draftSummary,
        nextActions: parseMultilineList(draftNextActions),
        unresolvedQuestions: parseMultilineList(draftUnresolvedQuestions),
        residualUnknowns: parseMultilineList(draftResidualUnknowns),
      });
      setDraftDialogOpen(false);
      resetDraftForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save onboarding draft");
    } finally {
      setDraftSaving(false);
    }
  }, [
    draftNextActions,
    draftResidualUnknowns,
    draftSummary,
    draftUnresolvedQuestions,
    persistDraftUpdate,
    resetDraftForm,
    snapshot?.draft,
  ]);

  const submitDraftWorkload = useCallback(async () => {
    if (!snapshot?.draft || !draftWorkloadDisplayName.trim()) {
      return;
    }

    setDraftWorkloadSaving(true);
    try {
      const keyBase = slugifyDraftKey(draftWorkloadDisplayName, "draft-workload");
      const usedKeys = [
        ...(snapshot.workloads ?? []).map((workload) => workload.workloadKey),
        ...draftWorkloads
          .filter((workload) => workload.workloadKey !== editingDraftWorkloadKey)
          .map((workload) => workload.workloadKey),
      ];
      const workloadKey = editingDraftWorkloadKey ?? uniqueDraftKey(usedKeys, keyBase);
      const nextWorkload: OnboardingDraftWorkload = {
        workloadKey,
        displayName: draftWorkloadDisplayName.trim(),
        category: draftWorkloadCategory,
        criticality: draftWorkloadCriticality,
        summary: draftWorkloadSummary.trim() || undefined,
      };
      const nextWorkloads = editingDraftWorkloadKey
        ? draftWorkloads.map((workload) => workload.workloadKey === editingDraftWorkloadKey ? nextWorkload : workload)
        : [...draftWorkloads, nextWorkload];

      await persistDraftUpdate({
        workloads: nextWorkloads,
        dismissedWorkloadKeys: (snapshot.draft.dismissedWorkloadKeys ?? []).filter(
          (key) => key.toLowerCase() !== workloadKey.toLowerCase(),
        ),
      });
      setDraftWorkloadDialogOpen(false);
      resetDraftWorkloadForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save draft responsibility");
    } finally {
      setDraftWorkloadSaving(false);
    }
  }, [
    draftWorkloadCategory,
    draftWorkloadCriticality,
    draftWorkloadDisplayName,
    draftWorkloadSummary,
    draftWorkloads,
    editingDraftWorkloadKey,
    persistDraftUpdate,
    resetDraftWorkloadForm,
    snapshot,
  ]);

  const submitDraftAssurance = useCallback(async () => {
    if (!snapshot?.draft || !draftAssuranceDisplayName.trim()) {
      return;
    }

    const parsedInterval = Number.parseInt(draftAssuranceCheckIntervalSec, 10);
    const checkIntervalSec = Number.isFinite(parsedInterval)
      ? Math.max(15, Math.min(3600, parsedInterval))
      : 120;
    const requiredProtocols = dedupeStrings(
      draftAssuranceRequiredProtocols
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );

    setDraftAssuranceSaving(true);
    try {
      const keyBase = slugifyDraftKey(draftAssuranceDisplayName, "draft-assurance");
      const usedKeys = [
        ...(snapshot.assurances ?? []).map((assurance) => assurance.assuranceKey),
        ...draftAssurances
          .filter((assurance) => assurance.assuranceKey !== editingDraftAssuranceKey)
          .map((assurance) => assurance.assuranceKey),
      ];
      const assuranceKey = editingDraftAssuranceKey ?? uniqueDraftKey(usedKeys, keyBase);
      const nextAssurance: OnboardingDraftAssurance = {
        assuranceKey,
        workloadKey: draftAssuranceWorkloadKey === "__none__" ? undefined : draftAssuranceWorkloadKey,
        displayName: draftAssuranceDisplayName.trim(),
        criticality: draftAssuranceCriticality,
        desiredState: draftAssuranceDesiredState,
        checkIntervalSec,
        monitorType: draftAssuranceMonitorType.trim() || undefined,
        requiredProtocols,
        rationale: draftAssuranceRationale.trim() || undefined,
      };
      const nextAssurances = editingDraftAssuranceKey
        ? draftAssurances.map((assurance) => assurance.assuranceKey === editingDraftAssuranceKey ? nextAssurance : assurance)
        : [...draftAssurances, nextAssurance];

      await persistDraftUpdate({
        assurances: nextAssurances,
        dismissedAssuranceKeys: (snapshot.draft.dismissedAssuranceKeys ?? []).filter(
          (key) => key.toLowerCase() !== assuranceKey.toLowerCase(),
        ),
      });
      setDraftAssuranceDialogOpen(false);
      resetDraftAssuranceForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save draft assurance");
    } finally {
      setDraftAssuranceSaving(false);
    }
  }, [
    draftAssuranceCheckIntervalSec,
    draftAssuranceCriticality,
    draftAssuranceDesiredState,
    draftAssuranceDisplayName,
    draftAssuranceMonitorType,
    draftAssuranceRationale,
    draftAssuranceRequiredProtocols,
    draftAssuranceWorkloadKey,
    draftAssurances,
    editingDraftAssuranceKey,
    persistDraftUpdate,
    resetDraftAssuranceForm,
    snapshot,
  ]);

  const deleteWorkload = useCallback(async (workload: Workload) => {
    const attachedAssurances = assurancesByWorkload.get(workload.id) ?? [];
    const confirmation = attachedAssurances.length > 0
      ? `Delete responsibility "${workload.displayName}" and its ${attachedAssurances.length} attached assurance${attachedAssurances.length === 1 ? "" : "s"}?`
      : `Delete responsibility "${workload.displayName}"?`;
    if (!window.confirm(confirmation)) {
      return;
    }

    setDeletingWorkloadId(workload.id);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/workloads/${workload.id}`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to delete workload");
      }

      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete workload");
    } finally {
      setDeletingWorkloadId(null);
    }
  }, [assurancesByWorkload, deviceId, refresh]);

  const deleteAssurance = useCallback(async (assurance: Assurance) => {
    if (!window.confirm(`Delete assurance "${assurance.displayName}"?`)) {
      return;
    }

    setDeletingAssuranceId(assurance.id);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/assurances/${assurance.id}`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to delete assurance");
      }

      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete assurance");
    } finally {
      setDeletingAssuranceId(null);
    }
  }, [deviceId, refresh]);

  const deleteDraftWorkload = useCallback(async (workload: OnboardingDraftWorkload) => {
    if (!snapshot?.draft) {
      return;
    }

    const attachedAssurances = draftAssurancesByWorkloadKey.get(workload.workloadKey) ?? [];
    const confirmation = attachedAssurances.length > 0
      ? `Delete draft responsibility "${workload.displayName}" and its ${attachedAssurances.length} attached draft assurance${attachedAssurances.length === 1 ? "" : "s"}?`
      : `Delete draft responsibility "${workload.displayName}"?`;
    if (!window.confirm(confirmation)) {
      return;
    }

    setDeletingDraftWorkloadKey(workload.workloadKey);
    try {
      await persistDraftUpdate({
        workloads: draftWorkloads.filter((item) => item.workloadKey !== workload.workloadKey),
        assurances: draftAssurances.filter((assurance) => assurance.workloadKey !== workload.workloadKey),
        dismissedWorkloadKeys: dedupeStrings([
          ...(snapshot.draft.dismissedWorkloadKeys ?? []),
          workload.workloadKey,
        ]),
        dismissedAssuranceKeys: dedupeStrings([
          ...(snapshot.draft.dismissedAssuranceKeys ?? []),
          ...attachedAssurances.map((assurance) => assurance.assuranceKey),
        ]),
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete draft responsibility");
    } finally {
      setDeletingDraftWorkloadKey(null);
    }
  }, [draftAssurances, draftAssurancesByWorkloadKey, draftWorkloads, persistDraftUpdate, snapshot?.draft]);

  const deleteDraftAssurance = useCallback(async (assurance: OnboardingDraftAssurance) => {
    if (!snapshot?.draft) {
      return;
    }
    if (!window.confirm(`Delete draft assurance "${assurance.displayName}"?`)) {
      return;
    }

    setDeletingDraftAssuranceKey(assurance.assuranceKey);
    try {
      await persistDraftUpdate({
        assurances: draftAssurances.filter((item) => item.assuranceKey !== assurance.assuranceKey),
        dismissedAssuranceKeys: dedupeStrings([
          ...(snapshot.draft.dismissedAssuranceKeys ?? []),
          assurance.assuranceKey,
        ]),
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete draft assurance");
    } finally {
      setDeletingDraftAssuranceKey(null);
    }
  }, [draftAssurances, persistDraftUpdate, snapshot?.draft]);

  const resetDraft = useCallback(async () => {
    if (!snapshot?.draft || !window.confirm("Reset the pending onboarding draft back to Steward's regenerated proposal?")) {
      return;
    }

    setDraftResetting(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/onboarding/draft?mode=reset`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to reset onboarding draft");
      }
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to reset onboarding draft");
    } finally {
      setDraftResetting(false);
    }
  }, [deviceId, refresh, snapshot?.draft]);

  const deleteDraft = useCallback(async () => {
    if (!snapshot?.draft || !window.confirm("Delete the pending onboarding draft outright? Steward will stop showing a proposal draft for this device until you regenerate one or continue onboarding in Chat.")) {
      return;
    }

    setDraftDeleting(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/onboarding/draft?mode=delete`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to delete onboarding draft");
      }
      setDraftDialogOpen(false);
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete onboarding draft");
    } finally {
      setDraftDeleting(false);
    }
  }, [deviceId, refresh, snapshot?.draft]);

  const regenerateDraft = useCallback(async () => {
    setDraftResetting(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/onboarding/draft?mode=reset`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to regenerate onboarding draft");
      }
      await refresh();
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to regenerate onboarding draft");
    } finally {
      setDraftResetting(false);
    }
  }, [deviceId, refresh]);

  const renderAssuranceCard = useCallback((assurance: Assurance) => {
    const latestRun = runByAssuranceId.get(assurance.id);
    const rationale = assurance.rationale
      ?? readString(assurance.configJson, "rationale")
      ?? readString(assurance.policyJson, "reason");
    const monitorType = assurance.monitorType
      ?? readString(assurance.configJson, "monitorType")
      ?? readString(assurance.policyJson, "monitorType");

    return (
      <div key={assurance.id} className="rounded-md border bg-background/70 p-2.5 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium">{assurance.displayName}</p>
            <p className="text-muted-foreground">
              Every {Math.max(1, Math.floor(assurance.checkIntervalSec))}s
              {monitorType ? ` · ${monitorType.replace(/_/g, " ")}` : ""}
              {assurance.desiredState ? ` · target ${assurance.desiredState}` : ""}
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

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={() => openEditAssuranceDialog(assurance)}
          >
            <Pencil className="mr-1 size-3" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] text-destructive"
            disabled={deletingAssuranceId === assurance.id}
            onClick={() => void deleteAssurance(assurance)}
          >
            {deletingAssuranceId === assurance.id ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Trash2 className="mr-1 size-3" />
            )}
            Delete
          </Button>
        </div>
      </div>
    );
  }, [deleteAssurance, deletingAssuranceId, openEditAssuranceDialog, runByAssuranceId]);

  const renderDraftAssuranceCard = useCallback((assurance: OnboardingDraftAssurance) => {
    return (
      <div key={`${assurance.assuranceKey}:draft-card`} className="rounded-md border border-amber-300/50 bg-background/60 p-2.5 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium">{assurance.displayName}</p>
            <p className="text-muted-foreground">
              Every {Math.max(1, Math.floor(assurance.checkIntervalSec))}s
              {assurance.monitorType ? ` · ${assurance.monitorType.replace(/_/g, " ")}` : ""}
              {assurance.desiredState ? ` · target ${assurance.desiredState}` : ""}
            </p>
          </div>
          <Badge variant="outline">{assurance.criticality}</Badge>
        </div>

        {assurance.rationale ? (
          <p className="mt-1 text-muted-foreground">{assurance.rationale}</p>
        ) : null}

        {(assurance.requiredProtocols ?? []).length > 0 ? (
          <p className="mt-1 text-muted-foreground">
            Needs access: {(assurance.requiredProtocols ?? []).join(", ")}
          </p>
        ) : null}

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={() => openEditDraftAssuranceDialog(assurance)}
          >
            <Pencil className="mr-1 size-3" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px] text-destructive"
            disabled={deletingDraftAssuranceKey === assurance.assuranceKey}
            onClick={() => void deleteDraftAssurance(assurance)}
          >
            {deletingDraftAssuranceKey === assurance.assuranceKey ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Trash2 className="mr-1 size-3" />
            )}
            Delete
          </Button>
        </div>
      </div>
    );
  }, [deleteDraftAssurance, deletingDraftAssuranceKey, openEditDraftAssuranceDialog]);

  return (
    <Card className={cn("flex min-h-0 flex-col bg-card/85", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Steward Contract</CardTitle>
            <CardDescription>
              Committed responsibilities, enforcement checks, and any pending onboarding contract changes for this device.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant={statusVariant(snapshot?.run?.status ?? "idle")}>{snapshot?.run?.status ?? "idle"}</Badge>
            {snapshot?.run?.stage ? <Badge variant="outline">{snapshot.run.stage}</Badge> : null}
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading Steward contract
          </div>
        ) : null}

        {!loading ? (
          <>
            <div className="grid gap-2 sm:grid-cols-5">
              <div className="rounded-md border bg-background/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Responsibilities</p>
                <p className="text-lg font-semibold tabular-nums">{snapshot?.workloads.length ?? 0}</p>
              </div>
              <div className="rounded-md border bg-background/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Assurances</p>
                <p className="text-lg font-semibold tabular-nums">{snapshot?.assurances.length ?? 0}</p>
              </div>
              <div className="rounded-md border bg-background/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Draft Responsibilities</p>
                <p className="text-lg font-semibold tabular-nums">{draftWorkloads.length}</p>
              </div>
              <div className="rounded-md border bg-background/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Draft Assurances</p>
                <p className="text-lg font-semibold tabular-nums">{draftAssurances.length}</p>
              </div>
              <div className="rounded-md border bg-background/50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Concerns</p>
                <p className="text-lg font-semibold tabular-nums">{openConcerns.length}</p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Steward should end onboarding with a committed responsibility contract. Edit responsibilities and checks here when you want deterministic control; use Chat when you want Steward to refine the model agentically.
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label className="text-xs">Committed Responsibilities</Label>
                  <p className="text-[11px] text-muted-foreground">
                    What Steward is explicitly responsible for keeping healthy on this endpoint.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => openCreateAssuranceDialog()}>
                    <Shield className="mr-1 size-3" />
                    Add Assurance
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={openCreateWorkloadDialog}>
                    <Plus className="mr-1 size-3" />
                    Add Responsibility
                  </Button>
                </div>
              </div>

              {(snapshot?.workloads.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No responsibilities have been committed yet. Finish onboarding in Chat to convert observed access and profiles into a concrete Steward contract.
                </p>
              ) : (
                <div className="space-y-2">
                  {snapshot?.workloads.map((workload) => {
                    const workloadAssurances = assurancesByWorkload.get(workload.id) ?? [];
                    return (
                      <div key={workload.id} className="rounded-md border bg-background/45 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-sm font-medium">{workload.displayName}</p>
                              <Badge variant="outline">{workload.category.replace(/_/g, " ")}</Badge>
                              <Badge variant="outline">{workload.criticality}</Badge>
                              <Badge variant="outline">{workload.source.replace(/_/g, " ")}</Badge>
                            </div>
                            {workload.summary ? (
                              <p className="text-xs text-muted-foreground">{workload.summary}</p>
                            ) : (
                              <p className="text-xs text-muted-foreground">No summary yet.</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => openCreateAssuranceDialog(workload.id)}
                            >
                              <Plus className="mr-1 size-3" />
                              Add Check
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => openEditWorkloadDialog(workload)}
                            >
                              <Pencil className="mr-1 size-3" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[10px] text-destructive"
                              disabled={deletingWorkloadId === workload.id}
                              onClick={() => void deleteWorkload(workload)}
                            >
                              {deletingWorkloadId === workload.id ? (
                                <Loader2 className="mr-1 size-3 animate-spin" />
                              ) : (
                                <Trash2 className="mr-1 size-3" />
                              )}
                              Delete
                            </Button>
                          </div>
                        </div>

                        <div className="mt-3 space-y-2">
                          {workloadAssurances.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No assurances attached yet.</p>
                          ) : (
                            workloadAssurances.map(renderAssuranceCard)
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {unassignedAssurances.length > 0 ? (
              <div className="space-y-2">
                <div>
                  <Label className="text-xs">Unassigned Assurances</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Checks that still exist without a linked responsibility. Clean these up or attach them to a responsibility.
                  </p>
                </div>
                <div className="space-y-2">
                  {unassignedAssurances.map(renderAssuranceCard)}
                </div>
              </div>
            ) : null}

            {snapshot?.draft ? (
              <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-950/15">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <Label className="text-xs">Pending Onboarding Draft</Label>
                    <p className="text-[11px] text-amber-900/80 dark:text-amber-100/80">
                      Current onboarding draft before final commitment.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={snapshot.draft.completionReady ? "default" : "secondary"}>
                      {snapshot.draft.completionReady ? "ready to commit" : "draft only"}
                    </Badge>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={openEditDraftDialog}>
                      <Pencil className="mr-1 size-3" />
                      Edit Draft
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={draftResetting}
                      onClick={() => void resetDraft()}
                    >
                      {draftResetting ? (
                        <Loader2 className="mr-1 size-3 animate-spin" />
                      ) : (
                        <Plus className="mr-1 size-3" />
                      )}
                      Regenerate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px] text-destructive"
                      disabled={draftDeleting}
                      onClick={() => void deleteDraft()}
                    >
                      {draftDeleting ? (
                        <Loader2 className="mr-1 size-3 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1 size-3" />
                      )}
                      Delete Draft
                    </Button>
                  </div>
                </div>

                {snapshot.draft.summary ? (
                  <p className="text-xs text-amber-900/90 dark:text-amber-100/90">{snapshot.draft.summary}</p>
                ) : null}

                <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-amber-900 dark:text-amber-100">Draft responsibilities and assurances</p>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => openCreateDraftAssuranceDialog()}
                        >
                          <Shield className="mr-1 size-3" />
                          Add Draft Assurance
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          onClick={openCreateDraftWorkloadDialog}
                        >
                          <Plus className="mr-1 size-3" />
                          Add Draft Responsibility
                        </Button>
                      </div>
                    </div>
                    {draftWorkloads.length === 0 && draftAssurances.length === 0 ? (
                      <p className="text-xs text-amber-900/80 dark:text-amber-100/80">No uncommitted contract changes.</p>
                    ) : null}
                    {draftWorkloads.map((workload) => {
                      const workloadAssurances = draftAssurancesByWorkloadKey.get(workload.workloadKey) ?? [];
                      return (
                        <div key={`${workload.workloadKey}:draft-workload`} className="rounded-md border border-amber-300/50 bg-background/60 px-2.5 py-2 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-medium">{workload.displayName}</p>
                              <p className="text-muted-foreground">{String(workload.category ?? "unknown").replace(/_/g, " ")} responsibility</p>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline">{workload.criticality}</Badge>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => openCreateDraftAssuranceDialog(workload.workloadKey)}
                              >
                                <Plus className="mr-1 size-3" />
                                Add Check
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => openEditDraftWorkloadDialog(workload)}
                              >
                                <Pencil className="mr-1 size-3" />
                                Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px] text-destructive"
                                disabled={deletingDraftWorkloadKey === workload.workloadKey}
                                onClick={() => void deleteDraftWorkload(workload)}
                              >
                                {deletingDraftWorkloadKey === workload.workloadKey ? (
                                  <Loader2 className="mr-1 size-3 animate-spin" />
                                ) : (
                                  <Trash2 className="mr-1 size-3" />
                                )}
                                Delete
                              </Button>
                            </div>
                          </div>
                          {workload.summary ? <p className="mt-1 text-muted-foreground">{workload.summary}</p> : null}

                          <div className="mt-2 space-y-2">
                            {workloadAssurances.length === 0 ? (
                              <p className="text-muted-foreground">No draft assurances attached yet.</p>
                            ) : (
                              workloadAssurances.map(renderDraftAssuranceCard)
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {unassignedDraftAssurances.length > 0 ? (
                      <div className="space-y-1.5">
                        <p className="text-[11px] font-medium text-amber-900 dark:text-amber-100">Unassigned draft assurances</p>
                        {unassignedDraftAssurances.map(renderDraftAssuranceCard)}
                      </div>
                    ) : null}
                </div>

                {(snapshot.draft.nextActions.length > 0 || snapshot.draft.unresolvedQuestions.length > 0) ? (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-medium text-amber-900 dark:text-amber-100">Next actions</p>
                      {snapshot.draft.nextActions.length === 0 ? (
                        <p className="text-xs text-amber-900/80 dark:text-amber-100/80">No next actions recorded.</p>
                      ) : (
                        snapshot.draft.nextActions.map((action, idx) => (
                          <p key={`${idx}:action`} className="text-xs text-amber-900/85 dark:text-amber-100/85">{action}</p>
                        ))
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-medium text-amber-900 dark:text-amber-100">Unresolved questions</p>
                      {snapshot.draft.unresolvedQuestions.length === 0 ? (
                        <p className="text-xs text-amber-900/80 dark:text-amber-100/80">No unresolved questions recorded.</p>
                      ) : (
                        snapshot.draft.unresolvedQuestions.map((question, idx) => (
                          <p key={`${idx}:question`} className="text-xs text-amber-900/85 dark:text-amber-100/85">{question}</p>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!snapshot?.draft && snapshot?.run && snapshot.run.status !== "completed" ? (
              <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-950/15">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <Label className="text-xs">Pending Onboarding Draft</Label>
                    <p className="text-[11px] text-amber-900/80 dark:text-amber-100/80">
                      No proposal draft is currently stored for this device.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    disabled={draftResetting}
                    onClick={() => void regenerateDraft()}
                  >
                    {draftResetting ? (
                      <Loader2 className="mr-1 size-3 animate-spin" />
                    ) : (
                      <Plus className="mr-1 size-3" />
                    )}
                    Generate Draft
                  </Button>
                </div>
                <p className="text-xs text-amber-900/90 dark:text-amber-100/90">
                  Continue onboarding in Chat or generate a fresh draft proposal here when you want Steward to propose workloads and assurances again.
                </p>
              </div>
            ) : null}

            {snapshot?.unresolvedRequiredQuestions ? (
              <p className="rounded-md border border-amber-300/60 bg-amber-50/70 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-100">
                Onboarding still has {snapshot.unresolvedRequiredQuestions} required question{snapshot.unresolvedRequiredQuestions === 1 ? "" : "s"} pending.
              </p>
            ) : null}

            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>

      <Dialog
        open={draftDialogOpen}
        onOpenChange={(open) => {
          setDraftDialogOpen(open);
          if (!open) {
            resetDraftForm();
          }
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Pending Onboarding Draft</DialogTitle>
            <DialogDescription>
              Refine the current onboarding summary and outstanding notes before Steward commits the contract.
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-0 gap-2 overflow-y-auto py-1 pr-1">
            <Label htmlFor="draft-summary">Summary</Label>
            <Textarea
              id="draft-summary"
              value={draftSummary}
              onChange={(event) => setDraftSummary(event.target.value)}
              placeholder="What Steward believes it should own for this device"
              rows={4}
            />

            <Label htmlFor="draft-next-actions">Next Actions</Label>
            <Textarea
              id="draft-next-actions"
              value={draftNextActions}
              onChange={(event) => setDraftNextActions(event.target.value)}
              placeholder="One action per line"
              rows={4}
            />

            <Label htmlFor="draft-unresolved-questions">Unresolved Questions</Label>
            <Textarea
              id="draft-unresolved-questions"
              value={draftUnresolvedQuestions}
              onChange={(event) => setDraftUnresolvedQuestions(event.target.value)}
              placeholder="One question per line"
              rows={4}
            />

            <Label htmlFor="draft-residual-unknowns">Residual Unknowns</Label>
            <Textarea
              id="draft-residual-unknowns"
              value={draftResidualUnknowns}
              onChange={(event) => setDraftResidualUnknowns(event.target.value)}
              placeholder="One unknown per line"
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftDialogOpen(false)} disabled={draftSaving || draftDeleting}>Cancel</Button>
            <Button variant="outline" className="text-destructive" onClick={() => void deleteDraft()} disabled={draftSaving || draftDeleting}>
              {draftDeleting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Trash2 className="mr-1.5 size-3.5" />}
              Delete Draft
            </Button>
            <Button onClick={() => void submitDraft()} disabled={draftSaving || draftDeleting}>
              {draftSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Save Draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={draftWorkloadDialogOpen}
        onOpenChange={(open) => {
          setDraftWorkloadDialogOpen(open);
          if (!open) {
            resetDraftWorkloadForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDraftWorkloadKey ? "Edit Draft Responsibility" : "Add Draft Responsibility"}</DialogTitle>
            <DialogDescription>
              Adjust the pending responsibility before it is committed into the Steward contract.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="draft-workload-display-name">Display Name</Label>
            <Input
              id="draft-workload-display-name"
              value={draftWorkloadDisplayName}
              onChange={(event) => setDraftWorkloadDisplayName(event.target.value)}
              placeholder="Print telemetry"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="draft-workload-category">Category</Label>
                <Select
                  value={draftWorkloadCategory}
                  onValueChange={(value) => setDraftWorkloadCategory(value as Workload["category"])}
                >
                  <SelectTrigger id="draft-workload-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKLOAD_CATEGORY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="draft-workload-criticality">Criticality</Label>
                <Select
                  value={draftWorkloadCriticality}
                  onValueChange={(value) => setDraftWorkloadCriticality(value as Workload["criticality"])}
                >
                  <SelectTrigger id="draft-workload-criticality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKLOAD_CRITICALITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Label htmlFor="draft-workload-summary">Summary</Label>
            <Textarea
              id="draft-workload-summary"
              value={draftWorkloadSummary}
              onChange={(event) => setDraftWorkloadSummary(event.target.value)}
              placeholder="What Steward should own once onboarding is committed"
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftWorkloadDialogOpen(false)} disabled={draftWorkloadSaving}>Cancel</Button>
            <Button onClick={() => void submitDraftWorkload()} disabled={draftWorkloadSaving || !draftWorkloadDisplayName.trim()}>
              {draftWorkloadSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {editingDraftWorkloadKey ? "Save Changes" : "Save Draft Responsibility"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={draftAssuranceDialogOpen}
        onOpenChange={(open) => {
          setDraftAssuranceDialogOpen(open);
          if (!open) {
            resetDraftAssuranceForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingDraftAssuranceKey ? "Edit Draft Assurance" : "Add Draft Assurance"}</DialogTitle>
            <DialogDescription>
              Adjust the pending checks Steward should commit after onboarding finishes.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="draft-assurance-display-name">Display Name</Label>
            <Input
              id="draft-assurance-display-name"
              value={draftAssuranceDisplayName}
              onChange={(event) => setDraftAssuranceDisplayName(event.target.value)}
              placeholder="MQTT heartbeat freshness"
            />

            <Label htmlFor="draft-assurance-workload">Linked Draft Responsibility</Label>
            <Select value={draftAssuranceWorkloadKey} onValueChange={setDraftAssuranceWorkloadKey}>
              <SelectTrigger id="draft-assurance-workload"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Unassigned</SelectItem>
                {draftWorkloads.map((workload) => (
                  <SelectItem key={workload.workloadKey} value={workload.workloadKey}>{workload.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="draft-assurance-criticality">Criticality</Label>
                <Select
                  value={draftAssuranceCriticality}
                  onValueChange={(value) => setDraftAssuranceCriticality(value as Assurance["criticality"])}
                >
                  <SelectTrigger id="draft-assurance-criticality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSURANCE_CRITICALITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="draft-assurance-desired-state">Desired State</Label>
                <Select
                  value={draftAssuranceDesiredState}
                  onValueChange={(value) => setDraftAssuranceDesiredState(value as Assurance["desiredState"])}
                >
                  <SelectTrigger id="draft-assurance-desired-state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSURANCE_DESIRED_STATE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="draft-assurance-interval">Interval (sec)</Label>
                <Input
                  id="draft-assurance-interval"
                  type="number"
                  min={15}
                  max={3600}
                  value={draftAssuranceCheckIntervalSec}
                  onChange={(event) => setDraftAssuranceCheckIntervalSec(event.target.value)}
                />
              </div>
            </div>

            <Label htmlFor="draft-assurance-monitor-type">Monitor Type</Label>
            <Input
              id="draft-assurance-monitor-type"
              value={draftAssuranceMonitorType}
              onChange={(event) => setDraftAssuranceMonitorType(event.target.value)}
              placeholder="workload_presence"
            />

            <Label htmlFor="draft-assurance-required-protocols">Required Access Protocols</Label>
            <Input
              id="draft-assurance-required-protocols"
              value={draftAssuranceRequiredProtocols}
              onChange={(event) => setDraftAssuranceRequiredProtocols(event.target.value)}
              placeholder="mqtt, http-api"
            />

            <Label htmlFor="draft-assurance-rationale">Rationale</Label>
            <Textarea
              id="draft-assurance-rationale"
              value={draftAssuranceRationale}
              onChange={(event) => setDraftAssuranceRationale(event.target.value)}
              placeholder="Why Steward should keep checking this after onboarding"
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraftAssuranceDialogOpen(false)} disabled={draftAssuranceSaving}>Cancel</Button>
            <Button onClick={() => void submitDraftAssurance()} disabled={draftAssuranceSaving || !draftAssuranceDisplayName.trim()}>
              {draftAssuranceSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {editingDraftAssuranceKey ? "Save Changes" : "Save Draft Assurance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={workloadDialogOpen}
        onOpenChange={(open) => {
          setWorkloadDialogOpen(open);
          if (!open) {
            resetWorkloadForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingWorkloadId ? "Edit Responsibility" : "Add Responsibility"}</DialogTitle>
            <DialogDescription>
              Define a workload Steward should explicitly own for this endpoint.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="workload-display-name">Display Name</Label>
            <Input
              id="workload-display-name"
              value={workloadDisplayName}
              onChange={(event) => setWorkloadDisplayName(event.target.value)}
              placeholder="Primary API Service"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="workload-category">Category</Label>
                <Select
                  value={workloadCategory}
                  onValueChange={(value) => setWorkloadCategory(value as Workload["category"])}
                >
                  <SelectTrigger id="workload-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKLOAD_CATEGORY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="workload-criticality">Criticality</Label>
                <Select
                  value={workloadCriticality}
                  onValueChange={(value) => setWorkloadCriticality(value as Workload["criticality"])}
                >
                  <SelectTrigger id="workload-criticality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WORKLOAD_CRITICALITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Label htmlFor="workload-summary">Summary</Label>
            <Textarea
              id="workload-summary"
              value={workloadSummary}
              onChange={(event) => setWorkloadSummary(event.target.value)}
              placeholder="What Steward is responsible for keeping healthy"
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setWorkloadDialogOpen(false)} disabled={workloadSaving}>Cancel</Button>
            <Button onClick={() => void submitWorkload()} disabled={workloadSaving || !workloadDisplayName.trim()}>
              {workloadSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {editingWorkloadId ? "Save Changes" : "Save Responsibility"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={assuranceDialogOpen}
        onOpenChange={(open) => {
          setAssuranceDialogOpen(open);
          if (!open) {
            resetAssuranceForm();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingAssuranceId ? "Edit Assurance" : "Add Assurance"}</DialogTitle>
            <DialogDescription>
              Define how Steward should keep checking this endpoint after onboarding is committed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="assurance-display-name">Display Name</Label>
            <Input
              id="assurance-display-name"
              value={assuranceDisplayName}
              onChange={(event) => setAssuranceDisplayName(event.target.value)}
              placeholder="API health check"
            />

            <Label htmlFor="assurance-workload">Linked Responsibility</Label>
            <Select value={assuranceWorkloadId} onValueChange={setAssuranceWorkloadId}>
              <SelectTrigger id="assurance-workload"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Unassigned</SelectItem>
                {(snapshot?.workloads ?? []).map((workload) => (
                  <SelectItem key={workload.id} value={workload.id}>{workload.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="assurance-criticality">Criticality</Label>
                <Select
                  value={assuranceCriticality}
                  onValueChange={(value) => setAssuranceCriticality(value as Assurance["criticality"])}
                >
                  <SelectTrigger id="assurance-criticality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSURANCE_CRITICALITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="assurance-desired-state">Desired State</Label>
                <Select
                  value={assuranceDesiredState}
                  onValueChange={(value) => setAssuranceDesiredState(value as Assurance["desiredState"])}
                >
                  <SelectTrigger id="assurance-desired-state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSURANCE_DESIRED_STATE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="assurance-interval">Interval (sec)</Label>
                <Input
                  id="assurance-interval"
                  type="number"
                  min={15}
                  max={3600}
                  value={assuranceCheckIntervalSec}
                  onChange={(event) => setAssuranceCheckIntervalSec(event.target.value)}
                />
              </div>
            </div>

            <Label htmlFor="assurance-monitor-type">Monitor Type</Label>
            <Input
              id="assurance-monitor-type"
              value={assuranceMonitorType}
              onChange={(event) => setAssuranceMonitorType(event.target.value)}
              placeholder="workload_presence"
            />

            <Label htmlFor="assurance-required-protocols">Required Access Protocols</Label>
            <Input
              id="assurance-required-protocols"
              value={assuranceRequiredProtocols}
              onChange={(event) => setAssuranceRequiredProtocols(event.target.value)}
              placeholder="ssh, http-api, mqtt"
            />

            <Label htmlFor="assurance-rationale">Rationale</Label>
            <Textarea
              id="assurance-rationale"
              value={assuranceRationale}
              onChange={(event) => setAssuranceRationale(event.target.value)}
              placeholder="Why Steward should keep checking this"
              rows={4}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAssuranceDialogOpen(false)} disabled={assuranceSaving}>Cancel</Button>
            <Button onClick={() => void submitAssurance()} disabled={assuranceSaving || !assuranceDisplayName.trim()}>
              {assuranceSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {editingAssuranceId ? "Save Changes" : "Save Assurance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export const DeviceContractsPanel = DeviceWorkloadsPanel;
