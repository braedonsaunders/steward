"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { useSteward } from "@/lib/hooks/use-steward";
import { DEVICE_TYPE_VALUES, type DeviceType } from "@/lib/state/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";

const DEVICE_TYPE_OPTIONS: DeviceType[] = [...DEVICE_TYPE_VALUES];

const CategorySelect = memo(function CategorySelect({
  value,
  onValueChange,
  onOpenChange,
}: {
  value: DeviceType;
  onValueChange: (value: DeviceType) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Select value={value} onOpenChange={onOpenChange} onValueChange={(next) => onValueChange(next as DeviceType)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {DEVICE_TYPE_OPTIONS.map((type) => (
          <SelectItem key={type} value={type}>{type}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

export function DeviceSettingsPanel({ deviceId }: { deviceId: string }) {
  const { devices, refresh, setDeviceAdoptionStatus } = useSteward();
  const device = devices.find((item) => item.id === deviceId);

  const [renameValue, setRenameValue] = useState(device?.name ?? "");
  const [categoryValue, setCategoryValue] = useState<DeviceType>(device?.type ?? "unknown");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [structuredMemoryJson, setStructuredMemoryJson] = useState("{}");
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingAdoption, setSavingAdoption] = useState(false);
  const [resettingOnboarding, setResettingOnboarding] = useState(false);
  const [confirmAdoptionOpen, setConfirmAdoptionOpen] = useState(false);
  const [pendingAdoptionStatus, setPendingAdoptionStatus] = useState<"discovered" | "ignored" | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCategoryValueChange = useCallback((value: DeviceType) => {
    setCategoryValue(value);
  }, []);

  const existingOperatorNotes = device
    && typeof device.metadata.notes === "object"
    && device.metadata.notes !== null
    && typeof (device.metadata.notes as Record<string, unknown>).operatorContext === "string"
    ? ((device.metadata.notes as Record<string, unknown>).operatorContext as string)
    : "";
  const existingOperatorNotesUpdatedAt = device
    && typeof device.metadata.notes === "object"
    && device.metadata.notes !== null
    && typeof (device.metadata.notes as Record<string, unknown>).operatorContextUpdatedAt === "string"
    ? ((device.metadata.notes as Record<string, unknown>).operatorContextUpdatedAt as string)
    : "";
  const existingStructuredContext = useMemo(() => (device
    && typeof device.metadata.notes === "object"
    && device.metadata.notes !== null
    && typeof (device.metadata.notes as Record<string, unknown>).structuredContext === "object"
    && (device.metadata.notes as Record<string, unknown>).structuredContext !== null
    ? (device.metadata.notes as Record<string, unknown>).structuredContext as Record<string, unknown>
    : {}), [device]);
  const existingStructuredContextJson = useMemo(() => JSON.stringify(existingStructuredContext, null, 2), [existingStructuredContext]);
  const currentDeviceId = device?.id;
  const currentDeviceName = device?.name ?? "";
  const currentDeviceType = device?.type ?? "unknown";

  useEffect(() => {
    if (!currentDeviceId || categoryOpen) return;
    setRenameValue((prev) => (prev === currentDeviceName ? prev : currentDeviceName));
    setCategoryValue((prev) => (prev === currentDeviceType ? prev : currentDeviceType));
    setOperatorNotes((prev) => (prev === existingOperatorNotes ? prev : existingOperatorNotes));
    setStructuredMemoryJson((prev) => (prev === existingStructuredContextJson ? prev : existingStructuredContextJson));
  }, [
    categoryOpen,
    currentDeviceId,
    currentDeviceName,
    currentDeviceType,
    existingOperatorNotes,
    existingStructuredContextJson,
  ]);

  if (!device) {
    return null;
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);
  const onboardingRunStatus = typeof device.metadata.adoption === "object"
    && device.metadata.adoption !== null
    && typeof (device.metadata.adoption as Record<string, unknown>).runStatus === "string"
    ? String((device.metadata.adoption as Record<string, unknown>).runStatus)
    : null;

  const trimmedRenameValue = renameValue.trim();
  const hasRenameChange = trimmedRenameValue.length > 0 && trimmedRenameValue !== device.name;
  const hasCategoryChange = categoryValue !== device.type;
  const trimmedOperatorNotes = operatorNotes.trim();
  const hasOperatorNotesChange = trimmedOperatorNotes !== existingOperatorNotes.trim();
  const hasStructuredMemoryEdit = structuredMemoryJson.trim() !== existingStructuredContextJson.trim();
  const hasPendingChanges = hasRenameChange || hasCategoryChange || hasOperatorNotesChange || hasStructuredMemoryEdit;

  const saveAdoption = async (status: "discovered" | "adopted" | "ignored"): Promise<boolean> => {
    if (status === adoptionStatus) return true;
    setSavingAdoption(true);
    try {
      await setDeviceAdoptionStatus(device.id, status);
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update adoption status");
      return false;
    } finally {
      setSavingAdoption(false);
    }
  };

  const onSelectAdoptionStatus = (status: "discovered" | "adopted" | "ignored") => {
    if (status === adoptionStatus) return;
    if (adoptionStatus === "adopted" && (status === "discovered" || status === "ignored")) {
      setPendingAdoptionStatus(status);
      setConfirmAdoptionOpen(true);
      return;
    }
    void saveAdoption(status);
  };

  const confirmAdoptionChange = async () => {
    if (!pendingAdoptionStatus) return;
    const success = await saveAdoption(pendingAdoptionStatus);
    if (!success) return;
    setConfirmAdoptionOpen(false);
    setPendingAdoptionStatus(null);
  };

  const resetOnboardingStatus = async () => {
    if (adoptionStatus !== "adopted" || resettingOnboarding) return;
    const confirmed = window.confirm(
      "Reset onboarding status for this device? Steward will reopen onboarding and show the Start Onboarding prompt again.",
    );
    if (!confirmed) return;

    setResettingOnboarding(true);
    try {
      const response = await fetch(`/api/devices/${device.id}/onboarding/reset`, withClientApiToken({ method: "POST" }));
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to reset onboarding status");
      }
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset onboarding status");
    } finally {
      setResettingOnboarding(false);
    }
  };

  const saveSettings = async () => {
    if (!hasPendingChanges) return;
    setSavingSettings(true);
    try {
      const patchPayload: Record<string, unknown> = {};
      if (hasRenameChange) {
        patchPayload.name = trimmedRenameValue;
      }
      if (hasCategoryChange) {
        patchPayload.type = categoryValue;
      }
      if (hasOperatorNotesChange) {
        patchPayload.operatorNotes = trimmedOperatorNotes || null;
      }
      if (hasStructuredMemoryEdit) {
        const parsed = structuredMemoryJson.trim().length > 0
          ? JSON.parse(structuredMemoryJson)
          : {};
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Structured memory must be a JSON object.");
        }

        if (JSON.stringify(parsed) !== JSON.stringify(existingStructuredContext)) {
          patchPayload.operatorMemoryJson = parsed;
        }
      }

      if (Object.keys(patchPayload).length > 0) {
        const res = await fetch(`/api/devices/${device.id}`, withClientApiToken({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patchPayload),
        }));
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to save device settings");
        }
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save device settings");
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <Card className="bg-card/85">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>Manage device identity and management settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Display Name</Label>
          <Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
        </div>

        <div className="space-y-2">
          <Label>Category</Label>
          <CategorySelect
            value={categoryValue}
            onOpenChange={setCategoryOpen}
            onValueChange={handleCategoryValueChange}
          />
        </div>

        <div className="space-y-2">
          <Label>Adoption</Label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={adoptionStatus === "adopted" ? "default" : "outline"}
              onClick={() => onSelectAdoptionStatus("adopted")}
              disabled={savingAdoption}
            >
              Adopt
            </Button>
            <Button
              size="sm"
              variant={adoptionStatus === "discovered" ? "default" : "outline"}
              onClick={() => onSelectAdoptionStatus("discovered")}
              disabled={savingAdoption}
            >
              Discovered
            </Button>
            <Button
              size="sm"
              variant={adoptionStatus === "ignored" ? "default" : "outline"}
              onClick={() => onSelectAdoptionStatus("ignored")}
              disabled={savingAdoption}
            >
              Ignore
            </Button>
          </div>
        </div>

        {adoptionStatus === "adopted" ? (
          <div className="space-y-2">
            <Label>Onboarding</Label>
            <p className="text-xs text-muted-foreground">
              {onboardingRunStatus === "completed"
                ? "Onboarding is complete. Reset it to show the Start Onboarding prompt again and rerun onboarding from Chat."
                : "Onboarding is currently open. Resetting it clears the current onboarding chat session and reopens the prompt."}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void resetOnboardingStatus()}
              disabled={resettingOnboarding}
            >
              {resettingOnboarding ? "Resetting..." : "Reset Onboarding Status"}
            </Button>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label>Operator Notes (LLM Context)</Label>
          {existingOperatorNotesUpdatedAt && (
            <p className="text-[11px] text-muted-foreground">
              Notes last updated: {new Date(existingOperatorNotesUpdatedAt).toLocaleString()}
            </p>
          )}
          <Textarea
            value={operatorNotes}
            onChange={(event) => setOperatorNotes(event.target.value)}
            placeholder="Write key facts Steward should remember about this device (workload role, dependencies, caveats)."
            className="min-h-28"
          />
        </div>

        <div className="space-y-2">
          <Label>Structured Memory JSON</Label>
          <Textarea
            value={structuredMemoryJson}
            onChange={(event) => setStructuredMemoryJson(event.target.value)}
            placeholder={`{\n  "appName": "AdminApp",\n  "runtime": "laravel"\n}`}
            className="min-h-36 font-mono text-xs"
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void saveSettings()} disabled={savingSettings || !hasPendingChanges}>
            {savingSettings ? "Saving..." : "Save Changes"}
          </Button>
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </CardContent>

      <Dialog
        open={confirmAdoptionOpen}
        onOpenChange={(open) => {
          setConfirmAdoptionOpen(open);
          if (!open) {
            setPendingAdoptionStatus(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm status change</DialogTitle>
            <DialogDescription>
              {pendingAdoptionStatus === "discovered"
                ? "This device is currently adopted. Switch it back to discovered?"
                : "This device is currently adopted. Move it to ignored?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setConfirmAdoptionOpen(false);
                setPendingAdoptionStatus(null);
              }}
              disabled={savingAdoption}
            >
              Cancel
            </Button>
            <Button onClick={() => void confirmAdoptionChange()} disabled={savingAdoption || !pendingAdoptionStatus}>
              {savingAdoption ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
