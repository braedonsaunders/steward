"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Assurance, AssuranceRun, Workload } from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface Snapshot { workloads: Workload[]; assurances: Assurance[]; assuranceRuns: AssuranceRun[]; }
interface MissionOwner { id: string; title: string; priority: "low" | "medium" | "high"; subagent?: { name: string } }
interface AutonomyPayload {
  deviceMissionIds: string[];
  workloadMissionIdsByWorkloadId: Record<string, string[]>;
  assuranceMissionIdsByAssuranceId: Record<string, string[]>;
  missions: MissionOwner[];
}

const RESPONSIBILITY_CATEGORIES: Workload["category"][] = ["application", "platform", "data", "network", "perimeter", "storage", "telemetry", "background", "unknown"];
const CRITICALITIES: Workload["criticality"][] = ["low", "medium", "high"];
const DESIRED_STATES: Assurance["desiredState"][] = ["running", "stopped"];

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(delta) || delta < 0) return "just now";
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function runVariant(status: AssuranceRun["status"] | "unknown"): "default" | "destructive" | "secondary" | "outline" {
  if (status === "pass") return "default";
  if (status === "fail") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

export function DeviceResponsibilitiesPanel({ deviceId, active = true, className }: { deviceId: string; active?: boolean; className?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [autonomy, setAutonomy] = useState<AutonomyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [responsibilityDialogOpen, setResponsibilityDialogOpen] = useState(false);
  const [editingResponsibilityId, setEditingResponsibilityId] = useState<string | null>(null);
  const [responsibilityDisplayName, setResponsibilityDisplayName] = useState("");
  const [responsibilityCategory, setResponsibilityCategory] = useState<Workload["category"]>("unknown");
  const [responsibilityCriticality, setResponsibilityCriticality] = useState<Workload["criticality"]>("medium");
  const [responsibilitySummary, setResponsibilitySummary] = useState("");
  const [responsibilitySaving, setResponsibilitySaving] = useState(false);
  const [deletingResponsibilityId, setDeletingResponsibilityId] = useState<string | null>(null);

  const [assuranceDialogOpen, setAssuranceDialogOpen] = useState(false);
  const [editingAssuranceId, setEditingAssuranceId] = useState<string | null>(null);
  const [assuranceResponsibilityId, setAssuranceResponsibilityId] = useState("__none__");
  const [assuranceDisplayName, setAssuranceDisplayName] = useState("");
  const [assuranceCriticality, setAssuranceCriticality] = useState<Assurance["criticality"]>("medium");
  const [assuranceDesiredState, setAssuranceDesiredState] = useState<Assurance["desiredState"]>("running");
  const [assuranceCheckIntervalSec, setAssuranceCheckIntervalSec] = useState("120");
  const [assuranceMonitorType, setAssuranceMonitorType] = useState("");
  const [assuranceRequiredProtocols, setAssuranceRequiredProtocols] = useState("");
  const [assuranceRationale, setAssuranceRationale] = useState("");
  const [assuranceSaving, setAssuranceSaving] = useState(false);
  const [deletingAssuranceId, setDeletingAssuranceId] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [nextSnapshot, nextAutonomy] = await Promise.all([
        fetchClientJson<Snapshot>(`/api/devices/${deviceId}/adoption`),
        fetchClientJson<AutonomyPayload>(`/api/devices/${deviceId}/autonomy`),
      ]);
      setSnapshot(nextSnapshot);
      setAutonomy(nextAutonomy);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load device responsibilities");
    } finally {
      setLoaded(true);
      if (!silent) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { setSnapshot(null); setAutonomy(null); setLoading(true); setLoaded(false); setError(null); }, [deviceId]);
  useEffect(() => { if (active && !loaded) void refresh(); }, [active, loaded, refresh]);
  useEffect(() => {
    if (!active || !loaded) return;
    const timer = window.setInterval(() => void refresh(true), 15_000);
    return () => window.clearInterval(timer);
  }, [active, loaded, refresh]);

  const missionsById = useMemo(() => new Map((autonomy?.missions ?? []).map((mission) => [mission.id, mission])), [autonomy?.missions]);
  const latestRuns = useMemo(() => {
    const runs = new Map<string, AssuranceRun>();
    for (const run of snapshot?.assuranceRuns ?? []) {
      const existing = runs.get(run.assuranceId);
      if (!existing || new Date(run.evaluatedAt).getTime() > new Date(existing.evaluatedAt).getTime()) runs.set(run.assuranceId, run);
    }
    return runs;
  }, [snapshot?.assuranceRuns]);
  const assurancesByResponsibility = useMemo(() => {
    const grouped = new Map<string, Assurance[]>();
    for (const assurance of snapshot?.assurances ?? []) {
      const key = assurance.workloadId ?? "__device__";
      grouped.set(key, [...(grouped.get(key) ?? []), assurance]);
    }
    return grouped;
  }, [snapshot?.assurances]);
  const responsibilities = snapshot?.workloads ?? [];
  const deviceWideAssurances = assurancesByResponsibility.get("__device__") ?? [];
  const hasCoverage = responsibilities.length > 0 || deviceWideAssurances.length > 0;

  const missionBadges = useCallback((ids: string[]) => ids
    .map((missionId) => missionsById.get(missionId))
    .filter((mission): mission is MissionOwner => Boolean(mission)), [missionsById]);
  const responsibilityOwners = useCallback((id: string) => {
    const ids = autonomy?.workloadMissionIdsByWorkloadId?.[id] ?? autonomy?.deviceMissionIds ?? [];
    return missionBadges(ids);
  }, [autonomy?.deviceMissionIds, autonomy?.workloadMissionIdsByWorkloadId, missionBadges]);
  const assuranceOwners = useCallback((assurance: Assurance) => {
    const ids = autonomy?.assuranceMissionIdsByAssuranceId?.[assurance.id]
      ?? (assurance.workloadId ? autonomy?.workloadMissionIdsByWorkloadId?.[assurance.workloadId] : undefined)
      ?? autonomy?.deviceMissionIds
      ?? [];
    return missionBadges(ids);
  }, [autonomy?.assuranceMissionIdsByAssuranceId, autonomy?.deviceMissionIds, autonomy?.workloadMissionIdsByWorkloadId, missionBadges]);

  const resetResponsibilityForm = () => {
    setEditingResponsibilityId(null);
    setResponsibilityDisplayName("");
    setResponsibilityCategory("unknown");
    setResponsibilityCriticality("medium");
    setResponsibilitySummary("");
  };
  const resetAssuranceForm = () => {
    setEditingAssuranceId(null);
    setAssuranceResponsibilityId("__none__");
    setAssuranceDisplayName("");
    setAssuranceCriticality("medium");
    setAssuranceDesiredState("running");
    setAssuranceCheckIntervalSec("120");
    setAssuranceMonitorType("");
    setAssuranceRequiredProtocols("");
    setAssuranceRationale("");
  };

  const openCreateResponsibility = () => { resetResponsibilityForm(); setResponsibilityDialogOpen(true); };
  const openEditResponsibility = (responsibility: Workload) => {
    setEditingResponsibilityId(responsibility.id);
    setResponsibilityDisplayName(responsibility.displayName);
    setResponsibilityCategory(responsibility.category);
    setResponsibilityCriticality(responsibility.criticality);
    setResponsibilitySummary(responsibility.summary ?? "");
    setResponsibilityDialogOpen(true);
  };
  const openCreateAssurance = (responsibilityId?: string) => { resetAssuranceForm(); setAssuranceResponsibilityId(responsibilityId ?? "__none__"); setAssuranceDialogOpen(true); };
  const openEditAssurance = (assurance: Assurance) => {
    setEditingAssuranceId(assurance.id);
    setAssuranceResponsibilityId(assurance.workloadId ?? "__none__");
    setAssuranceDisplayName(assurance.displayName);
    setAssuranceCriticality(assurance.criticality);
    setAssuranceDesiredState(assurance.desiredState ?? "running");
    setAssuranceCheckIntervalSec(String(Math.max(15, Math.floor(assurance.checkIntervalSec))));
    setAssuranceMonitorType(assurance.monitorType ?? "");
    setAssuranceRequiredProtocols((assurance.requiredProtocols ?? []).join(", "));
    setAssuranceRationale(assurance.rationale ?? "");
    setAssuranceDialogOpen(true);
  };

  const saveResponsibility = async () => {
    if (!responsibilityDisplayName.trim()) return;
    setResponsibilitySaving(true);
    try {
      const url = editingResponsibilityId ? `/api/devices/${deviceId}/workloads/${editingResponsibilityId}` : `/api/devices/${deviceId}/workloads`;
      await fetchClientJson(url, { method: editingResponsibilityId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: responsibilityDisplayName.trim(), category: responsibilityCategory, criticality: responsibilityCriticality, summary: responsibilitySummary.trim() || null }) });
      setResponsibilityDialogOpen(false);
      resetResponsibilityForm();
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save responsibility");
    } finally {
      setResponsibilitySaving(false);
    }
  };

  const saveAssurance = async () => {
    if (!assuranceDisplayName.trim()) return;
    const interval = Number.parseInt(assuranceCheckIntervalSec, 10);
    if (!Number.isFinite(interval) || interval < 15) {
      setError("Assurance interval must be at least 15 seconds.");
      return;
    }
    setAssuranceSaving(true);
    try {
      const url = editingAssuranceId ? `/api/devices/${deviceId}/assurances/${editingAssuranceId}` : `/api/devices/${deviceId}/assurances`;
      await fetchClientJson(url, { method: editingAssuranceId ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workloadId: assuranceResponsibilityId === "__none__" ? null : assuranceResponsibilityId, displayName: assuranceDisplayName.trim(), criticality: assuranceCriticality, desiredState: assuranceDesiredState, checkIntervalSec: interval, monitorType: assuranceMonitorType.trim() || null, requiredProtocols: assuranceRequiredProtocols.split(",").map((value) => value.trim()).filter(Boolean), rationale: assuranceRationale.trim() || null }) });
      setAssuranceDialogOpen(false);
      resetAssuranceForm();
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save assurance");
    } finally {
      setAssuranceSaving(false);
    }
  };

  const removeResponsibility = async (responsibility: Workload) => {
    const linkedAssurances = assurancesByResponsibility.get(responsibility.id) ?? [];
    const prompt = linkedAssurances.length > 0
      ? `Delete responsibility "${responsibility.displayName}" and its ${linkedAssurances.length} attached assurance${linkedAssurances.length === 1 ? "" : "s"}?`
      : `Delete responsibility "${responsibility.displayName}"?`;
    if (!window.confirm(prompt)) return;
    setDeletingResponsibilityId(responsibility.id);
    try {
      await fetchClientJson(`/api/devices/${deviceId}/workloads/${responsibility.id}`, { method: "DELETE" });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete responsibility");
    } finally {
      setDeletingResponsibilityId(null);
    }
  };

  const removeAssurance = async (assurance: Assurance) => {
    if (!window.confirm(`Delete assurance "${assurance.displayName}"?`)) return;
    setDeletingAssuranceId(assurance.id);
    try {
      await fetchClientJson(`/api/devices/${deviceId}/assurances/${assurance.id}`, { method: "DELETE" });
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete assurance");
    } finally {
      setDeletingAssuranceId(null);
    }
  };

  const renderMissionBadges = (owners: MissionOwner[]) => owners.length === 0 ? null : (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {owners.map((mission) => (
        <Badge key={mission.id} variant={mission.priority === "high" ? "secondary" : "outline"} className="text-[10px]">
          {mission.title}{mission.subagent?.name ? ` - ${mission.subagent.name}` : ""}
        </Badge>
      ))}
    </div>
  );

  const renderAssurance = (assurance: Assurance) => {
    const latestRun = latestRuns.get(assurance.id);
    const owners = assuranceOwners(assurance);
    return (
      <div key={assurance.id} className="rounded-md border bg-background/70 p-2.5 text-xs">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium">{assurance.displayName}</p>
            {renderMissionBadges(owners)}
            <p className="text-muted-foreground">
              Every {Math.max(1, Math.floor(assurance.checkIntervalSec))}s
              {assurance.monitorType ? ` - ${assurance.monitorType.replace(/_/g, " ")}` : ""}
              {assurance.desiredState ? ` - target ${assurance.desiredState}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">{assurance.criticality}</Badge>
            <Badge variant={runVariant(latestRun?.status ?? "unknown")}>{latestRun?.status ?? "unknown"}</Badge>
          </div>
        </div>
        {assurance.rationale ? <p className="mt-1 text-muted-foreground">{assurance.rationale}</p> : null}
        {(assurance.requiredProtocols ?? []).length > 0 ? <p className="mt-1 text-muted-foreground">Needs access: {(assurance.requiredProtocols ?? []).join(", ")}</p> : null}
        {latestRun ? (
          <>
            <p className="mt-1 text-muted-foreground">Last evaluated: {new Date(latestRun.evaluatedAt).toLocaleString()} ({relativeTime(latestRun.evaluatedAt)})</p>
            <p className="mt-1 text-muted-foreground">Last result: {latestRun.summary}</p>
          </>
        ) : (
          <p className="mt-1 text-amber-700 dark:text-amber-300">Never evaluated yet. Waiting for the scanner to pick this check up.</p>
        )}
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => openEditAssurance(assurance)}><Pencil className="mr-1 size-3" />Edit</Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-destructive" disabled={deletingAssuranceId === assurance.id} onClick={() => void removeAssurance(assurance)}>
            {deletingAssuranceId === assurance.id ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Trash2 className="mr-1 size-3" />}Delete
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Card className={cn("flex h-full min-h-0 flex-col bg-card/85", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Committed Responsibilities</CardTitle>
            <CardDescription>The deterministic responsibilities Steward owns on this device, with the checks enforcing each one.</CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={() => openCreateAssurance()}><Shield className="mr-1 size-3" />Add Assurance</Button>
            <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={openCreateResponsibility}><Plus className="mr-1 size-3" />Add Responsibility</Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        {loading ? <div className="flex items-center justify-center py-10 text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Loading responsibilities</div> : null}
        {!loading && error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">{error}</p> : null}
        {!loading && !hasCoverage ? <div className="rounded-lg border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">No responsibilities have been committed yet.</div> : null}

        {!loading && responsibilities.length > 0 ? <div className="space-y-3">
          {responsibilities.map((responsibility) => {
            const checks = assurancesByResponsibility.get(responsibility.id) ?? [];
            return (
              <div key={responsibility.id} className="rounded-md border bg-background/45 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-medium">{responsibility.displayName}</p>
                      <Badge variant="outline">{responsibility.category.replace(/_/g, " ")}</Badge>
                      <Badge variant="outline">{responsibility.criticality}</Badge>
                    </div>
                    {renderMissionBadges(responsibilityOwners(responsibility.id))}
                    {responsibility.summary ? <p className="text-xs text-muted-foreground">{responsibility.summary}</p> : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => openCreateAssurance(responsibility.id)}><Plus className="mr-1 size-3" />Add Check</Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => openEditResponsibility(responsibility)}><Pencil className="mr-1 size-3" />Edit</Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-destructive" disabled={deletingResponsibilityId === responsibility.id} onClick={() => void removeResponsibility(responsibility)}>
                      {deletingResponsibilityId === responsibility.id ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Trash2 className="mr-1 size-3" />}Delete
                    </Button>
                  </div>
                </div>
                <div className="mt-3 space-y-2">{checks.length === 0 ? <p className="text-xs text-muted-foreground">No assurances attached yet.</p> : checks.map(renderAssurance)}</div>
              </div>
            );
          })}
        </div> : null}

        {!loading && deviceWideAssurances.length > 0 ? <div className="rounded-md border bg-background/45 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5"><p className="text-sm font-medium">Device-wide coverage</p><Badge variant="outline">general</Badge></div>
              {renderMissionBadges(missionBadges(autonomy?.deviceMissionIds ?? []))}
              <p className="text-xs text-muted-foreground">Checks Steward enforces directly on the device rather than under a single responsibility.</p>
            </div>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => openCreateAssurance()}><Plus className="mr-1 size-3" />Add Check</Button>
          </div>
          <div className="mt-3 space-y-2">{deviceWideAssurances.map(renderAssurance)}</div>
        </div> : null}
      </CardContent>

      <Dialog open={responsibilityDialogOpen} onOpenChange={(open) => { setResponsibilityDialogOpen(open); if (!open) resetResponsibilityForm(); }}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingResponsibilityId ? "Edit Responsibility" : "Add Responsibility"}</DialogTitle><DialogDescription>Define a responsibility Steward should explicitly own for this endpoint.</DialogDescription></DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-2"><Label htmlFor="responsibility-display-name">Display Name</Label><Input id="responsibility-display-name" value={responsibilityDisplayName} onChange={(event) => setResponsibilityDisplayName(event.target.value)} placeholder="Database backups" /></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="responsibility-category">Category</Label><Select value={responsibilityCategory} onValueChange={(value) => setResponsibilityCategory(value as Workload["category"])}><SelectTrigger id="responsibility-category"><SelectValue /></SelectTrigger><SelectContent>{RESPONSIBILITY_CATEGORIES.map((option) => <SelectItem key={option} value={option}>{option.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="responsibility-criticality">Criticality</Label><Select value={responsibilityCriticality} onValueChange={(value) => setResponsibilityCriticality(value as Workload["criticality"])}><SelectTrigger id="responsibility-criticality"><SelectValue /></SelectTrigger><SelectContent>{CRITICALITIES.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="space-y-2"><Label htmlFor="responsibility-summary">Summary</Label><Textarea id="responsibility-summary" value={responsibilitySummary} onChange={(event) => setResponsibilitySummary(event.target.value)} rows={4} placeholder="What Steward should keep healthy for this device." /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setResponsibilityDialogOpen(false)} disabled={responsibilitySaving}>Cancel</Button><Button onClick={() => void saveResponsibility()} disabled={responsibilitySaving || !responsibilityDisplayName.trim()}>{responsibilitySaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}{editingResponsibilityId ? "Save Changes" : "Save Responsibility"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={assuranceDialogOpen} onOpenChange={(open) => { setAssuranceDialogOpen(open); if (!open) resetAssuranceForm(); }}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editingAssuranceId ? "Edit Assurance" : "Add Assurance"}</DialogTitle><DialogDescription>Define how Steward should keep checking this device after responsibilities are committed.</DialogDescription></DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-2"><Label htmlFor="assurance-display-name">Display Name</Label><Input id="assurance-display-name" value={assuranceDisplayName} onChange={(event) => setAssuranceDisplayName(event.target.value)} placeholder="Backup job succeeds" /></div>
            <div className="space-y-2"><Label htmlFor="assurance-responsibility">Linked Responsibility</Label><Select value={assuranceResponsibilityId} onValueChange={setAssuranceResponsibilityId}><SelectTrigger id="assurance-responsibility"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__none__">Device-wide</SelectItem>{responsibilities.map((responsibility) => <SelectItem key={responsibility.id} value={responsibility.id}>{responsibility.displayName}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="assurance-criticality">Criticality</Label><Select value={assuranceCriticality} onValueChange={(value) => setAssuranceCriticality(value as Assurance["criticality"])}><SelectTrigger id="assurance-criticality"><SelectValue /></SelectTrigger><SelectContent>{CRITICALITIES.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label htmlFor="assurance-desired-state">Desired State</Label><Select value={assuranceDesiredState} onValueChange={(value) => setAssuranceDesiredState(value as Assurance["desiredState"])}><SelectTrigger id="assurance-desired-state"><SelectValue /></SelectTrigger><SelectContent>{DESIRED_STATES.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="assurance-interval">Interval (sec)</Label><Input id="assurance-interval" type="number" min={15} step={15} value={assuranceCheckIntervalSec} onChange={(event) => setAssuranceCheckIntervalSec(event.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor="assurance-monitor-type">Monitor Type</Label><Input id="assurance-monitor-type" value={assuranceMonitorType} onChange={(event) => setAssuranceMonitorType(event.target.value)} placeholder="process_health" /></div>
            </div>
            <div className="space-y-2"><Label htmlFor="assurance-required-protocols">Required Access Protocols</Label><Input id="assurance-required-protocols" value={assuranceRequiredProtocols} onChange={(event) => setAssuranceRequiredProtocols(event.target.value)} placeholder="ssh, https" /></div>
            <div className="space-y-2"><Label htmlFor="assurance-rationale">Rationale</Label><Textarea id="assurance-rationale" value={assuranceRationale} onChange={(event) => setAssuranceRationale(event.target.value)} rows={4} placeholder="Why Steward should keep checking this responsibility." /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setAssuranceDialogOpen(false)} disabled={assuranceSaving}>Cancel</Button><Button onClick={() => void saveAssurance()} disabled={assuranceSaving || !assuranceDisplayName.trim()}>{assuranceSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}{editingAssuranceId ? "Save Changes" : "Save Assurance"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export const DeviceContractsPanel = DeviceResponsibilitiesPanel;
