"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { withClientApiToken } from "@/lib/auth/client-token";
import type { DeviceAutomation, DeviceWidget } from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface DeviceAutomationsPanelProps {
  deviceId: string;
  active?: boolean;
  className?: string;
}

type ScheduleKind = "manual" | "interval" | "daily";

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function scheduleLabel(automation: DeviceAutomation): string {
  if (automation.scheduleKind === "manual") {
    return "Manual only";
  }
  if (automation.scheduleKind === "interval") {
    return `Every ${automation.intervalMinutes} min`;
  }
  const hour = String(automation.hourLocal ?? 0).padStart(2, "0");
  const minute = String(automation.minuteLocal ?? 0).padStart(2, "0");
  return `Daily at ${hour}:${minute}`;
}

export function DeviceAutomationsPanel({
  deviceId,
  active = false,
  className,
}: DeviceAutomationsPanelProps) {
  const [widgets, setWidgets] = useState<DeviceWidget[]>([]);
  const [automations, setAutomations] = useState<DeviceAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string>("");
  const [selectedControlId, setSelectedControlId] = useState<string>("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("manual");
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [hourLocal, setHourLocal] = useState("09");
  const [minuteLocal, setMinuteLocal] = useState("00");
  const [enabled, setEnabled] = useState(true);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(null);
  const [deletingAutomationId, setDeletingAutomationId] = useState<string | null>(null);

  useEffect(() => {
    setWidgets([]);
    setAutomations([]);
    setLoading(true);
    setHasLoaded(false);
    setError(null);
  }, [deviceId]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [widgetsResponse, automationsResponse] = await Promise.all([
        fetch(`/api/devices/${deviceId}/widgets`, withClientApiToken()),
        fetch(`/api/devices/${deviceId}/automations`, withClientApiToken()),
      ]);
      const widgetsPayload = (await widgetsResponse.json()) as { widgets?: DeviceWidget[]; error?: string };
      const automationsPayload = (await automationsResponse.json()) as { automations?: DeviceAutomation[]; error?: string };
      if (!widgetsResponse.ok) {
        throw new Error(widgetsPayload.error ?? "Failed to load widgets.");
      }
      if (!automationsResponse.ok) {
        throw new Error(automationsPayload.error ?? "Failed to load automations.");
      }
      setWidgets(widgetsPayload.widgets ?? []);
      setAutomations(automationsPayload.automations ?? []);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load automations.");
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, [deviceId]);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void loadData();
  }, [active, hasLoaded, loadData]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [loadData]);

  const controllableWidgets = useMemo(
    () => widgets.filter((widget) => widget.controls.length > 0),
    [widgets],
  );
  const availableActionsCount = useMemo(
    () => controllableWidgets.reduce((count, widget) => count + widget.controls.length, 0),
    [controllableWidgets],
  );

  const selectedWidget = useMemo(
    () => controllableWidgets.find((widget) => widget.id === selectedWidgetId) ?? controllableWidgets[0] ?? null,
    [controllableWidgets, selectedWidgetId],
  );

  const selectedControl = useMemo(
    () => selectedWidget?.controls.find((control) => control.id === selectedControlId) ?? selectedWidget?.controls[0] ?? null,
    [selectedControlId, selectedWidget],
  );

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    const widget = controllableWidgets[0];
    if (widget && !selectedWidgetId) {
      setSelectedWidgetId(widget.id);
    }
  }, [controllableWidgets, dialogOpen, selectedWidgetId]);

  useEffect(() => {
    if (!selectedWidget) {
      return;
    }
    if (!selectedWidget.controls.some((control) => control.id === selectedControlId)) {
      setSelectedControlId(selectedWidget.controls[0]?.id ?? "");
    }
  }, [selectedControlId, selectedWidget]);

  useEffect(() => {
    if (!selectedControl) {
      setInputValues({});
      return;
    }
    const defaults = Object.fromEntries(
      selectedControl.parameters
        .filter((parameter) => typeof parameter.defaultValue !== "undefined")
        .map((parameter) => [parameter.key, String(parameter.defaultValue)]),
    );
    setInputValues(defaults);
    if (!name.trim()) {
      setName(`${selectedWidget?.name ?? "Widget"} · ${selectedControl.label}`);
    }
  }, [name, selectedControl, selectedWidget?.name]);

  const openCreateDialog = useCallback((widgetId?: string, controlId?: string) => {
    setDialogOpen(true);
    setSelectedWidgetId(widgetId ?? controllableWidgets[0]?.id ?? "");
    setSelectedControlId(controlId ?? "");
    setName("");
    setDescription("");
    setScheduleKind("manual");
    setIntervalMinutes("15");
    setHourLocal("09");
    setMinuteLocal("00");
    setEnabled(true);
    setInputValues({});
    setError(null);
  }, [controllableWidgets]);

  const createAutomation = useCallback(async () => {
    if (!selectedWidget || !selectedControl) {
      setError("Select an action first.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/automations`,
        withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            widgetId: selectedWidget.id,
            controlId: selectedControl.id,
            name: name.trim() || `${selectedWidget.name} · ${selectedControl.label}`,
            description: description.trim() || undefined,
            enabled,
            scheduleKind,
            intervalMinutes: scheduleKind === "interval" ? Number(intervalMinutes) : undefined,
            hourLocal: scheduleKind === "daily" ? Number(hourLocal) : undefined,
            minuteLocal: scheduleKind === "daily" ? Number(minuteLocal) : undefined,
            inputJson: inputValues,
          }),
        }),
      );
      const payload = (await response.json()) as { automation?: DeviceAutomation; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to create automation.");
      }
      setDialogOpen(false);
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create automation.");
    } finally {
      setSaving(false);
    }
  }, [
    description,
    deviceId,
    enabled,
    hourLocal,
    inputValues,
    intervalMinutes,
    loadData,
    minuteLocal,
    name,
    scheduleKind,
    selectedControl,
    selectedWidget,
  ]);

  const toggleAutomation = useCallback(async (automation: DeviceAutomation, nextEnabled: boolean) => {
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/automations/${automation.id}`,
        withClientApiToken({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to update automation.");
      }
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update automation.");
    }
  }, [deviceId, loadData]);

  const runAutomation = useCallback(async (automationId: string) => {
    setRunningAutomationId(automationId);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/automations/${automationId}/runs`,
        withClientApiToken({ method: "POST" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok && ![403, 409, 428].includes(response.status)) {
        throw new Error(payload.error ?? "Failed to run automation.");
      }
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to run automation.");
    } finally {
      setRunningAutomationId(null);
    }
  }, [deviceId, loadData]);

  const deleteAutomation = useCallback(async (automation: DeviceAutomation) => {
    if (!window.confirm(`Delete automation "${automation.name}"?`)) {
      return;
    }
    setDeletingAutomationId(automation.id);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/automations/${automation.id}`,
        withClientApiToken({ method: "DELETE" }),
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to delete automation.");
      }
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete automation.");
    } finally {
      setDeletingAutomationId(null);
    }
  }, [deviceId, loadData]);

  if (loading) {
    return (
      <Skeleton className={cn("h-[640px] w-full rounded-2xl", className)} />
    );
  }

  return (
    <>
      <Card className={className}>
        <CardHeader className="gap-3">
          <div className="flex items-center gap-2">
            <Clock3 className="size-4 text-primary" />
            <CardTitle className="text-base">Automations</CardTitle>
            <div className="ml-auto flex items-center gap-2">
              <Badge variant="secondary">{availableActionsCount} action{availableActionsCount === 1 ? "" : "s"}</Badge>
              <Badge variant="secondary">{automations.length} automation{automations.length === 1 ? "" : "s"}</Badge>
            </div>
          </div>
          <CardDescription>
            Create actions Steward can run immediately or on a schedule. Build and manage them directly here for this device.
          </CardDescription>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => openCreateDialog()}>
              <Plus className="mr-1.5 size-4" />
              New Automation
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refreshAll()} disabled={refreshing}>
              <RefreshCw className={cn("mr-1.5 size-4", refreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {error ? (
            <Card className="border-destructive/50">
              <CardContent className="p-3 text-sm text-destructive">{error}</CardContent>
            </Card>
          ) : null}

          {availableActionsCount === 0 && automations.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="space-y-2 p-4 text-sm text-muted-foreground">
                <p>No automations yet.</p>
                <p>This device does not have any automatable actions available right now. When one is available, you can create and manage the automation here without going through chat.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Play className="size-4 text-primary" />
                  <p className="text-sm font-medium">Available Actions</p>
                  <Badge variant="outline" className="ml-auto">{availableActionsCount}</Badge>
                </div>
                {availableActionsCount === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="p-4 text-sm text-muted-foreground">
                      No automatable actions are available on this device right now.
                    </CardContent>
                  </Card>
                ) : controllableWidgets.map((widget) => (
                  <div key={widget.id} className="rounded-xl border bg-background/50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{widget.name}</p>
                      <Badge variant="outline">{widget.slug}</Badge>
                      <Badge variant="outline">{widget.controls.length} control{widget.controls.length === 1 ? "" : "s"}</Badge>
                    </div>
                    {widget.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{widget.description}</p>
                    ) : null}
                    <div className="mt-3 space-y-2">
                      {widget.controls.map((control) => (
                        <div key={control.id} className="rounded-lg border bg-background/70 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">{control.label}</p>
                            <Badge variant="outline">{control.kind}</Badge>
                            <Badge variant="outline">{control.execution.kind}</Badge>
                          </div>
                          {control.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">{control.description}</p>
                          ) : null}
                          {control.parameters.length > 0 ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Inputs: {control.parameters.map((parameter) => parameter.label).join(", ")}
                            </p>
                          ) : (
                            <p className="mt-2 text-xs text-muted-foreground">No inputs required.</p>
                          )}
                          <div className="mt-3">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openCreateDialog(widget.id, control.id)}
                            >
                              Create automation
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </section>

              <div className="border-t border-border/60" />

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Clock3 className="size-4 text-primary" />
                  <p className="text-sm font-medium">Saved Automations</p>
                  <Badge variant="outline" className="ml-auto">{automations.length}</Badge>
                </div>
                {automations.length === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="p-4 text-sm text-muted-foreground">
                      No automations yet. Create one here from any available action on this device.
                    </CardContent>
                  </Card>
                ) : automations.map((automation) => {
                  const targetWidgetId = typeof automation.targetJson.widgetId === "string"
                    ? automation.targetJson.widgetId
                    : automation.widgetId;
                  const targetControlId = typeof automation.targetJson.controlId === "string"
                    ? automation.targetJson.controlId
                    : automation.controlId;
                  const widget = widgets.find((candidate) => candidate.id === targetWidgetId);
                  const control = widget?.controls.find((candidate) => candidate.id === targetControlId);
                  return (
                    <div key={automation.id} className="rounded-xl border bg-background/55 p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{automation.name}</p>
                            <Badge variant={automation.enabled ? "secondary" : "outline"}>
                              {automation.enabled ? "enabled" : "disabled"}
                            </Badge>
                            {automation.lastRunStatus ? (
                              <Badge variant={automation.lastRunStatus === "succeeded" ? "secondary" : "outline"}>
                                {automation.lastRunStatus}
                              </Badge>
                            ) : null}
                          </div>
                          {automation.description ? (
                            <p className="mt-1 text-xs text-muted-foreground">{automation.description}</p>
                          ) : null}
                          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                            <p>
                              Target: {automation.targetKind === "widget-control"
                                ? `${widget?.name ?? targetWidgetId} / ${control?.label ?? targetControlId}`
                                : automation.targetKind}
                            </p>
                            <p>Schedule: {scheduleLabel(automation)}</p>
                            <p>Last run: {formatTimestamp(automation.lastRunAt)}</p>
                            <p>Next run: {formatTimestamp(automation.nextRunAt)}</p>
                            {automation.lastRunSummary ? <p>Last summary: {automation.lastRunSummary}</p> : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Switch
                            checked={automation.enabled}
                            onCheckedChange={(checked) => void toggleAutomation(automation, checked)}
                          />
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={() => void runAutomation(automation.id)}
                            disabled={runningAutomationId === automation.id}
                          >
                            <Play className="size-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => void deleteAutomation(automation)}
                            disabled={deletingAutomationId === automation.id}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </section>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create automation</DialogTitle>
            <DialogDescription>
              Choose an available action, then decide whether it runs manually, on an interval, or daily.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {availableActionsCount === 0 ? (
              <Card className="border-dashed">
                <CardContent className="p-4 text-sm text-muted-foreground">
                  This device does not have any automatable actions available yet.
                </CardContent>
              </Card>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="automation-widget">Source</Label>
                  <Select value={selectedWidget?.id ?? ""} onValueChange={setSelectedWidgetId}>
                    <SelectTrigger id="automation-widget"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {controllableWidgets.map((widget) => (
                        <SelectItem key={widget.id} value={widget.id}>{widget.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="automation-control">Action</Label>
                  <Select value={selectedControl?.id ?? ""} onValueChange={setSelectedControlId}>
                    <SelectTrigger id="automation-control"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(selectedWidget?.controls ?? []).map((control) => (
                        <SelectItem key={control.id} value={control.id}>{control.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="automation-name">Name</Label>
                  <Input id="automation-name" value={name} onChange={(event) => setName(event.target.value)} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="automation-description">Description</Label>
                  <Textarea
                    id="automation-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="automation-schedule">Schedule</Label>
                  <Select value={scheduleKind} onValueChange={(value) => setScheduleKind(value as ScheduleKind)}>
                    <SelectTrigger id="automation-schedule"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual only</SelectItem>
                      <SelectItem value="interval">Interval</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {scheduleKind === "interval" ? (
                  <div className="space-y-2">
                    <Label htmlFor="automation-interval">Interval minutes</Label>
                    <Input id="automation-interval" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} />
                  </div>
                ) : null}

                {scheduleKind === "daily" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="automation-hour">Hour</Label>
                      <Input id="automation-hour" value={hourLocal} onChange={(event) => setHourLocal(event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="automation-minute">Minute</Label>
                      <Input id="automation-minute" value={minuteLocal} onChange={(event) => setMinuteLocal(event.target.value)} />
                    </div>
                  </div>
                ) : null}

                <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Enabled</p>
                    <p className="text-xs text-muted-foreground">Disabled automations stay saved but do not run on schedule.</p>
                  </div>
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                </div>

                {selectedControl?.parameters.length ? (
                  <div className="space-y-3 rounded-xl border bg-background/60 p-3">
                    <p className="text-sm font-medium">Action inputs</p>
                    {selectedControl.parameters.map((parameter) => (
                      <div key={parameter.key} className="space-y-2">
                        <Label htmlFor={`automation-input-${parameter.key}`}>
                          {parameter.label}
                          {parameter.required ? " *" : ""}
                        </Label>
                        <Input
                          id={`automation-input-${parameter.key}`}
                          value={inputValues[parameter.key] ?? ""}
                          placeholder={parameter.placeholder}
                          onChange={(event) => setInputValues((current) => ({
                            ...current,
                            [parameter.key]: event.target.value,
                          }))}
                        />
                        <p className="text-xs text-muted-foreground">{parameter.type}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void createAutomation()} disabled={saving || !selectedWidget || !selectedControl}>
              {saving ? <RefreshCw className="mr-1.5 size-4 animate-spin" /> : <Plus className="mr-1.5 size-4" />}
              Save automation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
