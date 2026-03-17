"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Calendar,
  Clock,
  PencilLine,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useSteward } from "@/lib/hooks/use-steward";
import type {
  ActionClass,
  AutonomyTier,
  DeviceType,
  EnvironmentLabel,
  MaintenanceWindow,
  PolicyDecision,
  PolicyRule,
} from "@/lib/state/types";
import { DEVICE_TYPE_VALUES } from "@/lib/state/types";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const ACTION_CLASS_OPTIONS: ActionClass[] = ["A", "B", "C", "D"];
const AUTONOMY_TIER_OPTIONS: AutonomyTier[] = [1, 2, 3];
const ENVIRONMENT_LABEL_OPTIONS: EnvironmentLabel[] = ["prod", "staging", "dev", "lab"];
const DEVICE_TYPE_SET = new Set<string>(DEVICE_TYPE_VALUES);

const ACTION_CLASS_COLORS: Record<ActionClass, string> = {
  A: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  B: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  C: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  D: "bg-red-500/15 text-red-700 dark:text-red-400",
};

interface PolicyRuleFormState {
  name: string;
  description: string;
  decision: PolicyDecision;
  priority: string;
  enabled: boolean;
  actionClasses: ActionClass[];
  autonomyTiers: AutonomyTier[];
  environmentLabels: EnvironmentLabel[];
  deviceTypesInput: string;
}

interface MaintenanceWindowFormState {
  name: string;
  cronStart: string;
  durationMinutes: string;
  enabled: boolean;
  deviceIds: string[];
}

function decisionVariant(
  decision: PolicyDecision,
): "default" | "secondary" | "destructive" | "outline" {
  switch (decision) {
    case "ALLOW_AUTO":
      return "default";
    case "REQUIRE_APPROVAL":
      return "secondary";
    case "DENY":
      return "destructive";
    default:
      return "outline";
  }
}

function decisionLabel(decision: PolicyDecision): string {
  switch (decision) {
    case "ALLOW_AUTO":
      return "Auto Allow";
    case "REQUIRE_APPROVAL":
      return "Require Approval";
    case "DENY":
      return "Deny";
    default:
      return decision;
  }
}

function makePolicyRuleFormState(rule?: PolicyRule): PolicyRuleFormState {
  return {
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    decision: rule?.decision ?? "REQUIRE_APPROVAL",
    priority: String(rule?.priority ?? 100),
    enabled: rule?.enabled ?? true,
    actionClasses: [...(rule?.actionClasses ?? [])],
    autonomyTiers: [...(rule?.autonomyTiers ?? [])],
    environmentLabels: [...(rule?.environmentLabels ?? [])],
    deviceTypesInput: (rule?.deviceTypes ?? []).join(", "),
  };
}

function makeMaintenanceWindowFormState(
  maintenanceWindow?: MaintenanceWindow,
): MaintenanceWindowFormState {
  return {
    name: maintenanceWindow?.name ?? "",
    cronStart: maintenanceWindow?.cronStart ?? "",
    durationMinutes: String(maintenanceWindow?.durationMinutes ?? 60),
    enabled: maintenanceWindow?.enabled ?? true,
    deviceIds: [...(maintenanceWindow?.deviceIds ?? [])],
  };
}

function toggleSelection<T extends string | number>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function parseDeviceTypesInput(input: string): { value: DeviceType[]; error: string | null } {
  const parsed = input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = parsed.filter((value) => !DEVICE_TYPE_SET.has(value));
  if (invalid.length > 0) {
    return {
      value: [],
      error: `Unknown device type${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
    };
  }
  return {
    value: parsed as DeviceType[],
    error: null,
  };
}

function ScopePills<T extends string | number>({
  label,
  values,
  selected,
  onToggle,
  renderLabel,
  colorMap,
}: {
  label: string;
  values: T[];
  selected: T[];
  onToggle: (value: T) => void;
  renderLabel?: (value: T) => string;
  colorMap?: Partial<Record<string, string>>;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => {
          const selectedValue = selected.includes(value);
          const labelValue = renderLabel?.(value) ?? String(value);
          const colorClass = colorMap?.[String(value)];
          return (
            <Button
              key={String(value)}
              type="button"
              variant={selectedValue ? "default" : "outline"}
              size="sm"
              className={cn(selectedValue && colorClass)}
              onClick={() => onToggle(value)}
            >
              {labelValue}
            </Button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Leave empty to match all values.</p>
    </div>
  );
}

function PolicyRuleDetail({
  rule,
  onClose,
}: {
  rule: PolicyRule;
  onClose: () => void;
}) {
  return (
    <Card className="border-primary/20 bg-muted/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">{rule.name}</CardTitle>
            <CardDescription>{rule.description || "No description provided."}</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Decision</p>
            <div className="mt-1">
              <Badge variant={decisionVariant(rule.decision)}>{decisionLabel(rule.decision)}</Badge>
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Priority</p>
            <p className="mt-1 text-sm tabular-nums">{rule.priority}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Action Classes</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.actionClasses?.length ? (
                rule.actionClasses.map((entry) => (
                  <Badge
                    key={entry}
                    className={cn("text-[10px] font-mono", ACTION_CLASS_COLORS[entry])}
                  >
                    {entry}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Autonomy Tiers</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.autonomyTiers?.length ? (
                rule.autonomyTiers.map((entry) => (
                  <Badge key={entry} variant="outline" className="text-[10px]">
                    Tier {entry}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Environment Labels</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.environmentLabels?.length ? (
                rule.environmentLabels.map((entry) => (
                  <Badge key={entry} variant="outline" className="text-[10px]">
                    {entry}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Device Types</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {rule.deviceTypes?.length ? (
                rule.deviceTypes.map((entry) => (
                  <Badge key={entry} variant="outline" className="text-[10px] capitalize">
                    {entry.replace(/-/g, " ")}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">All</span>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Enabled</p>
            <p className="mt-1 text-sm">{rule.enabled ? "Yes" : "No"}</p>
          </div>
        </div>
        <Separator />
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>Created {new Date(rule.createdAt).toLocaleDateString()}</span>
          <span>Updated {new Date(rule.updatedAt).toLocaleDateString()}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function PolicyRuleDialog({
  open,
  onOpenChange,
  initialRule,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRule?: PolicyRule | null;
  onSubmit: (payload: Omit<PolicyRule, "id" | "createdAt" | "updatedAt">) => Promise<void>;
}) {
  const [form, setForm] = useState<PolicyRuleFormState>(makePolicyRuleFormState(initialRule ?? undefined));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(makePolicyRuleFormState(initialRule ?? undefined));
    setError(null);
    setSaving(false);
  }, [initialRule, open]);

  const handleSubmit = async () => {
    const priority = Number.parseInt(form.priority, 10);
    if (!Number.isInteger(priority) || priority < 0) {
      setError("Priority must be a non-negative integer.");
      return;
    }
    const deviceTypes = parseDeviceTypesInput(form.deviceTypesInput);
    if (deviceTypes.error) {
      setError(deviceTypes.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        description: form.description.trim(),
        actionClasses: form.actionClasses,
        autonomyTiers: form.autonomyTiers,
        environmentLabels: form.environmentLabels,
        deviceTypes: deviceTypes.value,
        decision: form.decision,
        priority,
        enabled: form.enabled,
      });
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save policy rule.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initialRule ? "Edit Policy Rule" : "Add Policy Rule"}</DialogTitle>
          <DialogDescription>
            Define which action classes, environments, and device scopes Steward can auto-execute.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-4">
          <div className="grid gap-4 py-1">
            <div className="grid gap-2">
              <Label htmlFor="policy-rule-name">Name</Label>
              <Input
                id="policy-rule-name"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Block class D actions in prod"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="policy-rule-description">Description</Label>
              <Textarea
                id="policy-rule-description"
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Require approvals for high-blast-radius changes on production assets."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="policy-rule-decision">Decision</Label>
                <Select
                  value={form.decision}
                  onValueChange={(value) =>
                    setForm((current) => ({ ...current, decision: value as PolicyDecision }))
                  }
                >
                  <SelectTrigger id="policy-rule-decision">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALLOW_AUTO">Auto Allow</SelectItem>
                    <SelectItem value="REQUIRE_APPROVAL">Require Approval</SelectItem>
                    <SelectItem value="DENY">Deny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="policy-rule-priority">Priority</Label>
                <Input
                  id="policy-rule-priority"
                  type="number"
                  min="0"
                  value={form.priority}
                  onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="policy-rule-enabled">Enabled</Label>
                <div className="flex h-10 items-center rounded-lg border px-3">
                  <Switch
                    id="policy-rule-enabled"
                    checked={form.enabled}
                    onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
                  />
                  <span className="ml-3 text-sm text-muted-foreground">
                    {form.enabled ? "Rule active" : "Rule disabled"}
                  </span>
                </div>
              </div>
            </div>
            <ScopePills
              label="Action Classes"
              values={ACTION_CLASS_OPTIONS}
              selected={form.actionClasses}
              colorMap={ACTION_CLASS_COLORS}
              onToggle={(value) =>
                setForm((current) => ({
                  ...current,
                  actionClasses: toggleSelection(current.actionClasses, value),
                }))
              }
            />
            <ScopePills
              label="Autonomy Tiers"
              values={AUTONOMY_TIER_OPTIONS}
              selected={form.autonomyTiers}
              renderLabel={(value) => `Tier ${value}`}
              onToggle={(value) =>
                setForm((current) => ({
                  ...current,
                  autonomyTiers: toggleSelection(current.autonomyTiers, value),
                }))
              }
            />
            <ScopePills
              label="Environment Labels"
              values={ENVIRONMENT_LABEL_OPTIONS}
              selected={form.environmentLabels}
              onToggle={(value) =>
                setForm((current) => ({
                  ...current,
                  environmentLabels: toggleSelection(current.environmentLabels, value),
                }))
              }
            />
            <div className="grid gap-2">
              <Label htmlFor="policy-rule-device-types">Device Types</Label>
              <Input
                id="policy-rule-device-types"
                value={form.deviceTypesInput}
                onChange={(event) =>
                  setForm((current) => ({ ...current, deviceTypesInput: event.target.value }))
                }
                placeholder="server, nas, firewall"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Leave blank to target every device type.
              </p>
            </div>
            {error ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button disabled={saving || !form.name.trim()} onClick={handleSubmit}>
            {saving ? "Saving..." : initialRule ? "Save Changes" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaintenanceWindowDialog({
  open,
  onOpenChange,
  initialWindow,
  devices,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialWindow?: MaintenanceWindow | null;
  devices: Array<{ id: string; name: string; ip: string }>;
  onSubmit: (payload: Omit<MaintenanceWindow, "id" | "createdAt">) => Promise<void>;
}) {
  const [form, setForm] = useState<MaintenanceWindowFormState>(
    makeMaintenanceWindowFormState(initialWindow ?? undefined),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(makeMaintenanceWindowFormState(initialWindow ?? undefined));
    setError(null);
    setSaving(false);
  }, [initialWindow, open]);

  const handleSubmit = async () => {
    const durationMinutes = Number.parseInt(form.durationMinutes, 10);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
      setError("Duration must be a positive integer.");
      return;
    }
    if (!form.cronStart.trim()) {
      setError("Cron start is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: form.name.trim(),
        cronStart: form.cronStart.trim(),
        durationMinutes,
        enabled: form.enabled,
        deviceIds: form.deviceIds,
      });
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to save maintenance window.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initialWindow ? "Edit Maintenance Window" : "Add Maintenance Window"}</DialogTitle>
          <DialogDescription>
            Define when higher-risk automation is allowed and which devices are covered by the window.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[65vh] pr-4">
          <div className="grid gap-4 py-1">
            <div className="grid gap-2">
              <Label htmlFor="maintenance-window-name">Name</Label>
              <Input
                id="maintenance-window-name"
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Sunday night patching"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="maintenance-window-cron">Cron Schedule (start)</Label>
                <Input
                  id="maintenance-window-cron"
                  className="font-mono"
                  value={form.cronStart}
                  onChange={(event) => setForm((current) => ({ ...current, cronStart: event.target.value }))}
                  placeholder="0 2 * * 0"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="maintenance-window-duration">Duration (minutes)</Label>
                <Input
                  id="maintenance-window-duration"
                  type="number"
                  min="1"
                  value={form.durationMinutes}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, durationMinutes: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maintenance-window-enabled">Enabled</Label>
              <div className="flex h-10 items-center rounded-lg border px-3">
                <Switch
                  id="maintenance-window-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))}
                />
                <span className="ml-3 text-sm text-muted-foreground">
                  {form.enabled ? "Window active" : "Window disabled"}
                </span>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Scoped Devices</Label>
              <div className="rounded-lg border">
                <ScrollArea className="max-h-64">
                  <div className="grid gap-2 p-3">
                    {devices.map((device) => {
                      const selected = form.deviceIds.includes(device.id);
                      return (
                        <button
                          key={device.id}
                          type="button"
                          className={cn(
                            "flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-primary bg-primary/5"
                              : "border-border bg-card hover:bg-muted/50",
                          )}
                          onClick={() =>
                            setForm((current) => ({
                              ...current,
                              deviceIds: toggleSelection(current.deviceIds, device.id),
                            }))
                          }
                        >
                          <div>
                            <p className="text-sm font-medium">{device.name}</p>
                            <p className="font-mono text-xs text-muted-foreground">{device.ip}</p>
                          </div>
                          <Badge variant={selected ? "default" : "outline"}>
                            {selected ? "Included" : "Excluded"}
                          </Badge>
                        </button>
                      );
                    })}
                    {devices.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No devices discovered yet.</p>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave the list empty to create a window without device restrictions.
              </p>
            </div>
            {error ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button disabled={saving || !form.name.trim()} onClick={handleSubmit}>
            {saving ? "Saving..." : initialWindow ? "Save Changes" : "Create Window"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MaintenanceWindowCard({
  window,
  deviceNames,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  window: MaintenanceWindow;
  deviceNames: string[];
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{window.name}</CardTitle>
            <CardDescription className="mt-1">
              {window.deviceIds.length === 0
                ? "All devices"
                : `${window.deviceIds.length} device${window.deviceIds.length === 1 ? "" : "s"}`}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={window.enabled} onCheckedChange={onToggleEnabled} />
            <Button variant="outline" size="icon" onClick={onEdit}>
              <PencilLine className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-xs">{window.cronStart}</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span>{window.durationMinutes} minutes</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {deviceNames.length > 0 ? (
            deviceNames.map((name) => (
              <Badge key={name} variant="outline" className="text-[10px]">
                {name}
              </Badge>
            ))
          ) : (
            <Badge variant="outline" className="text-[10px]">
              No device scope
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Created {new Date(window.createdAt).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  );
}

export default function PoliciesPage() {
  const {
    devices,
    policyRules,
    maintenanceWindows,
    loading,
    createPolicyRule,
    updatePolicyRule,
    deletePolicyRule,
    createMaintenanceWindow,
    updateMaintenanceWindow,
    deleteMaintenanceWindow,
  } = useSteward();
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [editRuleOpen, setEditRuleOpen] = useState(false);
  const [addWindowOpen, setAddWindowOpen] = useState(false);
  const [editWindowOpen, setEditWindowOpen] = useState(false);
  const [selectedRule, setSelectedRule] = useState<PolicyRule | null>(null);
  const [selectedWindow, setSelectedWindow] = useState<MaintenanceWindow | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const sortedRules = useMemo(
    () => [...policyRules].sort((a, b) => a.priority - b.priority),
    [policyRules],
  );
  const deviceOptions = useMemo(
    () =>
      devices
        .map((device) => ({
          id: device.id,
          name: device.name,
          ip: device.ip,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [devices],
  );
  const deviceNameById = useMemo(
    () => new Map(deviceOptions.map((device) => [device.id, device.name])),
    [deviceOptions],
  );

  const handlePolicyDelete = async (rule: PolicyRule) => {
    if (!window.confirm(`Delete policy rule "${rule.name}"?`)) {
      return;
    }
    try {
      setMutationError(null);
      await deletePolicyRule(rule.id);
      if (expandedRule === rule.id) {
        setExpandedRule(null);
      }
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Failed to delete policy rule.");
    }
  };

  const handleMaintenanceWindowDelete = async (maintenanceWindow: MaintenanceWindow) => {
    if (!window.confirm(`Delete maintenance window "${maintenanceWindow.name}"?`)) {
      return;
    }
    try {
      setMutationError(null);
      await deleteMaintenanceWindow(maintenanceWindow.id);
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "Failed to delete maintenance window.",
      );
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-64" />
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((entry) => (
            <Skeleton key={entry} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-muted-foreground" />
        <h1 className="steward-heading-font text-2xl font-semibold tracking-tight">
          Policy Management
        </h1>
      </div>

      {mutationError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {mutationError}
        </p>
      ) : null}

      <PolicyRuleDialog
        open={addRuleOpen}
        onOpenChange={setAddRuleOpen}
        onSubmit={async (payload) => {
          setMutationError(null);
          await createPolicyRule(payload);
        }}
      />
      <PolicyRuleDialog
        open={editRuleOpen}
        onOpenChange={setEditRuleOpen}
        initialRule={selectedRule}
        onSubmit={async (payload) => {
          if (!selectedRule) {
            return;
          }
          setMutationError(null);
          await updatePolicyRule(selectedRule.id, payload);
        }}
      />
      <MaintenanceWindowDialog
        open={addWindowOpen}
        onOpenChange={setAddWindowOpen}
        devices={deviceOptions}
        onSubmit={async (payload) => {
          setMutationError(null);
          await createMaintenanceWindow(payload);
        }}
      />
      <MaintenanceWindowDialog
        open={editWindowOpen}
        onOpenChange={setEditWindowOpen}
        initialWindow={selectedWindow}
        devices={deviceOptions}
        onSubmit={async (payload) => {
          if (!selectedWindow) {
            return;
          }
          setMutationError(null);
          await updateMaintenanceWindow(selectedWindow.id, payload);
        }}
      />

      <Tabs defaultValue="rules" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="rules">
            <ShieldCheck className="mr-1.5 h-4 w-4" />
            Policy Rules
            <Badge variant="secondary" className="ml-1.5 tabular-nums text-[10px]">
              {policyRules.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="windows">
            <Calendar className="mr-1.5 h-4 w-4" />
            Maintenance Windows
            <Badge variant="secondary" className="ml-1.5 tabular-nums text-[10px]">
              {maintenanceWindows.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4 min-h-0 flex-1 space-y-4 overflow-auto">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddRuleOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Rule
            </Button>
          </div>

          {policyRules.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
                <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-muted-foreground">No policy rules configured</p>
                  <p className="text-xs text-muted-foreground/70">
                    Add rules to control how Steward handles different action classes and autonomy tiers.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="overflow-hidden">
                <CardContent className="p-0 md:p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Priority</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Action Classes</TableHead>
                        <TableHead>Tiers</TableHead>
                        <TableHead>Decision</TableHead>
                        <TableHead>Enabled</TableHead>
                        <TableHead className="w-[124px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedRules.map((rule) => (
                        <TableRow
                          key={rule.id}
                          className="cursor-pointer"
                          onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}
                        >
                          <TableCell className="tabular-nums font-mono text-xs">{rule.priority}</TableCell>
                          <TableCell className="font-medium">{rule.name}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {rule.actionClasses?.length ? (
                                rule.actionClasses.map((entry) => (
                                  <Badge
                                    key={entry}
                                    className={cn("text-[10px] font-mono", ACTION_CLASS_COLORS[entry])}
                                  >
                                    {entry}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-xs text-muted-foreground">All</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {rule.autonomyTiers?.length ? (
                              <span className="text-sm tabular-nums">{rule.autonomyTiers.join(", ")}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">All</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={decisionVariant(rule.decision)}>
                              {decisionLabel(rule.decision)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Switch
                              checked={rule.enabled}
                              onClick={(event) => event.stopPropagation()}
                              onCheckedChange={async (enabled) => {
                                try {
                                  setMutationError(null);
                                  await updatePolicyRule(rule.id, { enabled });
                                } catch (error) {
                                  setMutationError(
                                    error instanceof Error
                                      ? error.message
                                      : "Failed to update policy rule.",
                                  );
                                }
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedRule(rule);
                                  setEditRuleOpen(true);
                                }}
                              >
                                <PencilLine className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="icon"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handlePolicyDelete(rule);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {expandedRule ? (
                <PolicyRuleDetail
                  rule={sortedRules.find((rule) => rule.id === expandedRule)!}
                  onClose={() => setExpandedRule(null)}
                />
              ) : null}
            </>
          )}
        </TabsContent>

        <TabsContent value="windows" className="mt-4 min-h-0 flex-1 space-y-4 overflow-auto">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddWindowOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Window
            </Button>
          </div>
          {maintenanceWindows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-3 py-16">
                <Calendar className="h-10 w-10 text-muted-foreground/40" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-muted-foreground">
                    No maintenance windows configured
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    Define recurring windows when automated actions have relaxed policy restrictions.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {maintenanceWindows.map((maintenanceWindow) => (
                <MaintenanceWindowCard
                  key={maintenanceWindow.id}
                  window={maintenanceWindow}
                  deviceNames={maintenanceWindow.deviceIds
                    .map((deviceId) => deviceNameById.get(deviceId))
                    .filter((name): name is string => Boolean(name))}
                  onEdit={() => {
                    setSelectedWindow(maintenanceWindow);
                    setEditWindowOpen(true);
                  }}
                  onDelete={() => {
                    void handleMaintenanceWindowDelete(maintenanceWindow);
                  }}
                  onToggleEnabled={async (enabled) => {
                    try {
                      setMutationError(null);
                      await updateMaintenanceWindow(maintenanceWindow.id, { enabled });
                    } catch (error) {
                      setMutationError(
                        error instanceof Error
                          ? error.message
                          : "Failed to update maintenance window.",
                      );
                    }
                  }}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
