"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PauseCircle, Play, RefreshCw, Search, Settings2, Target } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { countMissionTrackedSignals } from "@/lib/missions/tracking";

interface MissionSelector {
  allDevices?: boolean;
  deviceIds?: string[];
  deviceTypes?: string[];
  deviceNames?: string[];
  servicesWithTls?: boolean;
  workloadCategory?: string;
  workloadNamePattern?: string;
  assuranceMonitorTypes?: string[];
}

interface MissionTarget {
  selector?: MissionSelector;
  incidentTypes?: string[];
  findingTypes?: string[];
  recommendationPattern?: string;
  scheduleMode?: "cadence" | "systemDigest";
}

interface MissionItem {
  id: string;
  title: string;
  summary: string;
  objective: string;
  kind: string;
  status: "active" | "paused" | "completed" | "archived";
  priority: "low" | "medium" | "high";
  cadenceMinutes: number;
  nextRunAt?: string;
  lastStatus?: string;
  lastSummary?: string;
  shadowMode: boolean;
  autoRun: boolean;
  autoApprove: boolean;
  targetJson: MissionTarget;
  stateJson?: Record<string, unknown>;
  subagentId?: string;
  subagent?: {
    id?: string;
    name: string;
  };
  openInvestigations: Array<{ id: string }>;
}

interface SubagentItem {
  id: string;
  name: string;
}

interface DeviceItem {
  id: string;
  name: string;
  ip: string;
  type: string;
}

interface MissionEditorState {
  id: string;
  title: string;
  summary: string;
  objective: string;
  priority: "low" | "medium" | "high";
  status: "active" | "paused" | "completed" | "archived";
  cadenceMinutes: string;
  subagentId: string;
  autoRun: boolean;
  autoApprove: boolean;
  shadowMode: boolean;
  allDevices: boolean;
  servicesWithTls: boolean;
  selectedDeviceIds: string[];
}

function formatWhen(value?: string): string {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cadenceLabel(minutes: number): string {
  if (minutes >= 60 * 24) return `${Math.round(minutes / (60 * 24))}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function formatScope(mission: MissionItem, devicesById: Map<string, DeviceItem>): string {
  const selector = mission.targetJson.selector;
  if (!selector) {
    return "No selector";
  }

  const parts: string[] = [];
  if (selector.allDevices) {
    parts.push("all devices");
  }
  if ((selector.deviceIds ?? []).length > 0) {
    const deviceNames = (selector.deviceIds ?? [])
      .slice(0, 2)
      .map((deviceId) => devicesById.get(deviceId)?.name ?? deviceId);
    const remainder = Math.max(0, (selector.deviceIds?.length ?? 0) - deviceNames.length);
    parts.push(remainder > 0 ? `${deviceNames.join(", ")} +${remainder}` : deviceNames.join(", "));
  }
  if (selector.deviceTypes?.length) {
    parts.push(selector.deviceTypes.join(", "));
  }
  if (selector.servicesWithTls) {
    parts.push("TLS");
  }
  if (selector.workloadCategory) {
    parts.push(`${selector.workloadCategory} responsibilities`);
  }
  if (selector.assuranceMonitorTypes?.length) {
    parts.push(`assurances:${selector.assuranceMonitorTypes.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "No selector";
}

function buildEditorState(mission: MissionItem): MissionEditorState {
  return {
    id: mission.id,
    title: mission.title,
    summary: mission.summary,
    objective: mission.objective,
    priority: mission.priority,
    status: mission.status,
    cadenceMinutes: String(mission.cadenceMinutes),
    subagentId: mission.subagentId ?? "__none__",
    autoRun: mission.autoRun,
    autoApprove: mission.autoApprove,
    shadowMode: mission.shadowMode,
    allDevices: mission.targetJson.selector?.allDevices ?? false,
    servicesWithTls: mission.targetJson.selector?.servicesWithTls ?? false,
    selectedDeviceIds: mission.targetJson.selector?.deviceIds ?? [],
  };
}

export default function MissionsPage() {
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [subagents, setSubagents] = useState<SubagentItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [savingMission, setSavingMission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [deviceQuery, setDeviceQuery] = useState("");
  const [editor, setEditor] = useState<MissionEditorState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [missionResponse, subagentResponse, deviceResponse] = await Promise.all([
        fetchClientJson<{ missions: MissionItem[] }>("/api/missions"),
        fetchClientJson<{ subagents: SubagentItem[] }>("/api/subagents"),
        fetchClientJson<{ devices: DeviceItem[] }>("/api/devices"),
      ]);
      setMissions(missionResponse.missions);
      setSubagents(subagentResponse.subagents);
      setDevices(deviceResponse.devices);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load missions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runMission = async (id: string) => {
    setWorkingId(id);
    setError(null);
    try {
      await fetchClientJson(`/api/missions/${id}/run`, { method: "POST" });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to queue mission");
    } finally {
      setWorkingId(null);
    }
  };

  const toggleMission = async (mission: MissionItem) => {
    setWorkingId(mission.id);
    setError(null);
    try {
      await fetchClientJson(`/api/missions/${mission.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: mission.status === "active" ? "paused" : "active",
        }),
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update mission");
    } finally {
      setWorkingId(null);
    }
  };

  const openEditor = (mission: MissionItem) => {
    setDeviceQuery("");
    setEditor(buildEditorState(mission));
  };

  const closeEditor = () => {
    if (savingMission) {
      return;
    }
    setEditor(null);
    setDeviceQuery("");
  };

  const toggleEditorDevice = (deviceId: string) => {
    setEditor((current) => {
      if (!current) return current;
      const nextSelected = current.selectedDeviceIds.includes(deviceId)
        ? current.selectedDeviceIds.filter((value) => value !== deviceId)
        : [...current.selectedDeviceIds, deviceId];
      return {
        ...current,
        allDevices: false,
        selectedDeviceIds: nextSelected,
      };
    });
  };

  const saveMission = async () => {
    if (!editor) {
      return;
    }
    setSavingMission(true);
    setError(null);
    try {
      const existing = missions.find((mission) => mission.id === editor.id);
      const selector: Partial<MissionSelector> = {
        ...(existing?.targetJson.selector ?? {}),
        allDevices: editor.allDevices,
        servicesWithTls: editor.servicesWithTls,
        deviceIds: editor.allDevices ? [] : editor.selectedDeviceIds,
      };
      if (!selector.servicesWithTls) {
        delete selector.servicesWithTls;
      }
      if (!selector.deviceIds?.length) {
        delete selector.deviceIds;
      }
      if (!selector.allDevices) {
        delete selector.allDevices;
      }

      await fetchClientJson(`/api/missions/${editor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editor.title,
          summary: editor.summary,
          objective: editor.objective,
          priority: editor.priority,
          status: editor.status,
          subagentId: editor.subagentId === "__none__" ? null : editor.subagentId,
          cadenceMinutes: Math.max(1, Number(editor.cadenceMinutes) || 60),
          autoRun: editor.autoRun,
          autoApprove: editor.autoApprove,
          shadowMode: editor.shadowMode,
          targetJson: {
            ...(existing?.targetJson ?? {}),
            selector,
          },
        }),
      });

      closeEditor();
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save mission");
    } finally {
      setSavingMission(false);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredMissions = missions.filter((mission) => {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = [
      mission.title,
      mission.summary,
      mission.kind,
      mission.subagent?.name ?? "",
      mission.lastSummary ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const activeCount = missions.filter((mission) => mission.status === "active").length;
  const pausedCount = missions.filter((mission) => mission.status === "paused").length;
  const openInvestigationCount = missions.reduce((sum, mission) => sum + countMissionTrackedSignals(mission), 0);
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const filteredDevices = devices.filter((device) => {
    const normalizedDeviceQuery = deviceQuery.trim().toLowerCase();
    if (!normalizedDeviceQuery) {
      return true;
    }
    return `${device.name} ${device.ip} ${device.type}`.toLowerCase().includes(normalizedDeviceQuery);
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Target className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="steward-heading-font text-2xl font-semibold tracking-tight">Missions</h1>
            <p className="text-sm text-muted-foreground">Durable responsibilities Steward owns over time.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search missions"
              className="pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        {[["Active", activeCount], ["Paused", pausedCount], ["Open Investigations", openInvestigationCount]].map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? <Skeleton className="h-9 w-20" /> : <p className="text-3xl font-semibold">{value}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="min-h-0 flex-1">
        <CardHeader>
          <CardTitle>Mission Control</CardTitle>
        </CardHeader>
        <CardContent className="overflow-auto">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mission</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Subagent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Cadence</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Investigations</TableHead>
                  <TableHead>Last Result</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMissions.map((mission) => (
                  <TableRow key={mission.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{mission.title}</span>
                          <Badge variant="outline">{mission.kind}</Badge>
                          <Badge variant={mission.priority === "high" ? "destructive" : mission.priority === "medium" ? "secondary" : "outline"}>
                            {mission.priority}
                          </Badge>
                          {mission.shadowMode ? <Badge variant="secondary">shadow</Badge> : null}
                        </div>
                        <p className="max-w-xl text-xs text-muted-foreground">{mission.summary}</p>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs text-xs text-muted-foreground">{formatScope(mission, devicesById)}</TableCell>
                    <TableCell>{mission.subagent?.name ?? "Unassigned"}</TableCell>
                    <TableCell>
                      <Badge variant={mission.status === "active" ? "default" : "outline"}>{mission.status}</Badge>
                    </TableCell>
                    <TableCell>{cadenceLabel(mission.cadenceMinutes)}</TableCell>
                    <TableCell>{formatWhen(mission.nextRunAt)}</TableCell>
                    <TableCell>{countMissionTrackedSignals(mission)}</TableCell>
                    <TableCell className="max-w-sm text-xs text-muted-foreground">
                      {mission.lastSummary ?? mission.lastStatus ?? "No runs yet"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEditor(mission)} disabled={workingId === mission.id}>
                          <Settings2 className="mr-1.5 h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" disabled={workingId === mission.id} onClick={() => void toggleMission(mission)}>
                          <PauseCircle className="mr-1.5 h-3.5 w-3.5" />
                          {mission.status === "active" ? "Pause" : "Activate"}
                        </Button>
                        <Button size="sm" disabled={workingId === mission.id} onClick={() => void runMission(mission.id)}>
                          {workingId === mission.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                          Run
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredMissions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                      No missions match the current search.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Mission Configuration</DialogTitle>
            <DialogDescription>Adjust cadence, owner, and explicit scope without dropping into raw mission JSON.</DialogDescription>
          </DialogHeader>

          {editor ? (
            <div className="grid gap-4 py-1">
              <div className="grid gap-2 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="mission-title">Title</Label>
                  <Input id="mission-title" value={editor.title} onChange={(event) => setEditor((current) => current ? { ...current, title: event.target.value } : current)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mission-subagent">Subagent</Label>
                  <Select value={editor.subagentId} onValueChange={(value) => setEditor((current) => current ? { ...current, subagentId: value } : current)}>
                    <SelectTrigger id="mission-subagent">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Unassigned</SelectItem>
                      {subagents.map((subagent) => (
                        <SelectItem key={subagent.id} value={subagent.id}>{subagent.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="mission-summary">Summary</Label>
                <Textarea id="mission-summary" rows={3} value={editor.summary} onChange={(event) => setEditor((current) => current ? { ...current, summary: event.target.value } : current)} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="mission-objective">Objective</Label>
                <Textarea id="mission-objective" rows={3} value={editor.objective} onChange={(event) => setEditor((current) => current ? { ...current, objective: event.target.value } : current)} />
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                <div className="grid gap-2">
                  <Label htmlFor="mission-priority">Priority</Label>
                  <Select value={editor.priority} onValueChange={(value: "low" | "medium" | "high") => setEditor((current) => current ? { ...current, priority: value } : current)}>
                    <SelectTrigger id="mission-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">low</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="high">high</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mission-status">Status</Label>
                  <Select value={editor.status} onValueChange={(value: MissionEditorState["status"]) => setEditor((current) => current ? { ...current, status: value } : current)}>
                    <SelectTrigger id="mission-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">active</SelectItem>
                      <SelectItem value="paused">paused</SelectItem>
                      <SelectItem value="completed">completed</SelectItem>
                      <SelectItem value="archived">archived</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mission-cadence">Cadence (minutes)</Label>
                  <Input id="mission-cadence" type="number" min={1} value={editor.cadenceMinutes} onChange={(event) => setEditor((current) => current ? { ...current, cadenceMinutes: event.target.value } : current)} />
                </div>
                <div className="grid gap-2">
                  <Label>Modes</Label>
                  <div className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    {editor.autoRun ? "auto-run" : "manual"} · {editor.autoApprove ? "auto-approve" : "approval gated"}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Auto-run</p>
                    <p className="text-xs text-muted-foreground">Keep the mission waking on its cadence.</p>
                  </div>
                  <Switch checked={editor.autoRun} onCheckedChange={(checked) => setEditor((current) => current ? { ...current, autoRun: Boolean(checked) } : current)} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Auto-approve</p>
                    <p className="text-xs text-muted-foreground">Allow mission-owned actions without approval.</p>
                  </div>
                  <Switch checked={editor.autoApprove} onCheckedChange={(checked) => setEditor((current) => current ? { ...current, autoApprove: Boolean(checked) } : current)} />
                </div>
                <div className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Shadow mode</p>
                    <p className="text-xs text-muted-foreground">Run and brief without taking operator-facing action.</p>
                  </div>
                  <Switch checked={editor.shadowMode} onCheckedChange={(checked) => setEditor((current) => current ? { ...current, shadowMode: Boolean(checked) } : current)} />
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Device scope</p>
                    <p className="text-xs text-muted-foreground">Scope a mission to all devices or explicitly chosen devices.</p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Label htmlFor="mission-all-devices">All devices</Label>
                    <Switch
                      id="mission-all-devices"
                      checked={editor.allDevices}
                      onCheckedChange={(checked) => setEditor((current) => current ? {
                        ...current,
                        allDevices: Boolean(checked),
                        selectedDeviceIds: checked ? [] : current.selectedDeviceIds,
                      } : current)}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">TLS-only selector</p>
                    <p className="text-xs text-muted-foreground">Require observed TLS services in addition to device scope.</p>
                  </div>
                  <Switch checked={editor.servicesWithTls} onCheckedChange={(checked) => setEditor((current) => current ? { ...current, servicesWithTls: Boolean(checked) } : current)} />
                </div>

                {!editor.allDevices ? (
                  <div className="grid gap-3">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input value={deviceQuery} onChange={(event) => setDeviceQuery(event.target.value)} placeholder="Filter devices" className="pl-9" />
                    </div>
                    <div className="max-h-52 overflow-auto rounded-lg border border-border/70 p-2">
                      <div className="grid gap-2 sm:grid-cols-2">
                        {filteredDevices.map((device) => {
                          const selected = editor.selectedDeviceIds.includes(device.id);
                          return (
                            <button
                              key={device.id}
                              type="button"
                              onClick={() => toggleEditorDevice(device.id)}
                              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${selected ? "border-primary bg-primary/8" : "border-border/70 hover:bg-muted/40"}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">{device.name}</span>
                                {selected ? <Badge variant="default">Scoped</Badge> : <Badge variant="outline">{device.type}</Badge>}
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">{device.ip}</p>
                            </button>
                          );
                        })}
                        {filteredDevices.length === 0 ? (
                          <div className="col-span-full rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-sm text-muted-foreground">
                            No devices match the current filter.
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {editor.selectedDeviceIds.length > 0
                        ? `${editor.selectedDeviceIds.length} device${editor.selectedDeviceIds.length === 1 ? "" : "s"} explicitly scoped.`
                        : "No explicit devices selected. Turn on All devices or choose specific endpoints."}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={savingMission}>Cancel</Button>
            <Button onClick={() => void saveMission()} disabled={savingMission || !editor?.title.trim()}>
              {savingMission ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Save Mission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
