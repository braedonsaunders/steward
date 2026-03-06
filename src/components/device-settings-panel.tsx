"use client";

import { useEffect, useMemo, useState } from "react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { useSteward } from "@/lib/hooks/use-steward";
import type { DeviceType } from "@/lib/state/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";

const DEVICE_TYPE_OPTIONS: DeviceType[] = [
  "server",
  "workstation",
  "router",
  "firewall",
  "switch",
  "access-point",
  "camera",
  "nas",
  "printer",
  "iot",
  "container-host",
  "hypervisor",
  "unknown",
];

export function DeviceSettingsPanel({ deviceId }: { deviceId: string }) {
  const { devices, renameDevice, setDeviceAdoptionStatus, refresh } = useSteward();
  const device = devices.find((item) => item.id === deviceId);

  const [renameValue, setRenameValue] = useState(device?.name ?? "");
  const [categoryValue, setCategoryValue] = useState<DeviceType>(device?.type ?? "unknown");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [structuredMemoryJson, setStructuredMemoryJson] = useState("{}");
  const [savingRename, setSavingRename] = useState(false);
  const [savingCategory, setSavingCategory] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStructuredMemory, setSavingStructuredMemory] = useState(false);
  const [savingAdoption, setSavingAdoption] = useState(false);
  const [confirmAdoptionOpen, setConfirmAdoptionOpen] = useState(false);
  const [pendingAdoptionStatus, setPendingAdoptionStatus] = useState<"discovered" | "ignored" | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!device) return;
    setRenameValue(device.name);
    setCategoryValue(device.type);
    setOperatorNotes(existingOperatorNotes);
    setStructuredMemoryJson(JSON.stringify(existingStructuredContext, null, 2));
  }, [device, existingOperatorNotes, existingStructuredContext]);

  if (!device) {
    return null;
  }

  const adoptionStatus = getDeviceAdoptionStatus(device);

  const saveRename = async () => {
    if (!renameValue.trim() || renameValue.trim() === device.name) return;
    setSavingRename(true);
    try {
      await renameDevice(device.id, renameValue.trim());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename device");
    } finally {
      setSavingRename(false);
    }
  };

  const saveCategory = async () => {
    if (categoryValue === device.type) return;
    setSavingCategory(true);
    try {
      const res = await fetch(`/api/devices/${device.id}`, withClientApiToken({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: categoryValue }),
      }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to update category");
      }
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update category");
    } finally {
      setSavingCategory(false);
    }
  };

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

  const saveOperatorNotes = async () => {
    setSavingNotes(true);
    try {
      const res = await fetch(`/api/devices/${device.id}`, withClientApiToken({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorNotes: operatorNotes.trim() || null }),
      }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save notes");
      }
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save notes");
    } finally {
      setSavingNotes(false);
    }
  };

  const saveStructuredMemory = async () => {
    setSavingStructuredMemory(true);
    try {
      const parsed = structuredMemoryJson.trim().length > 0
        ? JSON.parse(structuredMemoryJson)
        : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Structured memory must be a JSON object.");
      }

      const res = await fetch(`/api/devices/${device.id}`, withClientApiToken({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorMemoryJson: parsed }),
      }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save structured memory");
      }
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save structured memory");
    } finally {
      setSavingStructuredMemory(false);
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
          <div className="flex gap-2">
            <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
            <Button onClick={() => void saveRename()} disabled={savingRename || !renameValue.trim()}>
              {savingRename ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Category</Label>
          <div className="flex gap-2">
            <Select value={categoryValue} onValueChange={(value) => setCategoryValue(value as DeviceType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => void saveCategory()} disabled={savingCategory}>
              {savingCategory ? "Saving..." : "Save"}
            </Button>
          </div>
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
          <div className="flex justify-end">
            <Button onClick={() => void saveOperatorNotes()} disabled={savingNotes}>
              {savingNotes ? "Saving..." : "Save Notes"}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Structured Memory JSON</Label>
          <Textarea
            value={structuredMemoryJson}
            onChange={(event) => setStructuredMemoryJson(event.target.value)}
            placeholder={`{\n  "appName": "AdminApp",\n  "runtime": "laravel"\n}`}
            className="min-h-36 font-mono text-xs"
          />
          <div className="flex justify-end">
            <Button onClick={() => void saveStructuredMemory()} disabled={savingStructuredMemory}>
              {savingStructuredMemory ? "Saving..." : "Save Structured Memory"}
            </Button>
          </div>
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
