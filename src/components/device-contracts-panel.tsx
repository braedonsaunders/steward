"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type {
  AdoptionQuestion,
  AdoptionRun,
  DeviceAdapterBinding,
  DeviceCredential,
  DeviceFinding,
  ServiceContract,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  deviceId: string;
  run: AdoptionRun | null;
  questions: AdoptionQuestion[];
  unresolvedRequiredQuestions: number;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  bindings: DeviceAdapterBinding[];
  serviceContracts: ServiceContract[];
}

interface FindingsPayload {
  findings: DeviceFinding[];
}

const statusVariant = (
  status: AdoptionRun["status"] | "idle",
): "default" | "destructive" | "secondary" | "outline" => {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "awaiting_user") return "secondary";
  return "outline";
};

export function DeviceContractsPanel({ deviceId, className }: { deviceId: string; className?: string }) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [findings, setFindings] = useState<DeviceFinding[]>([]);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [snapshotRes, findingsRes] = await Promise.all([
        fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken()),
        fetch(`/api/devices/${deviceId}/findings`, withClientApiToken()),
      ]);
      const snapshotData = (await snapshotRes.json()) as AdoptionSnapshot | { error?: string };
      if (!snapshotRes.ok) {
        throw new Error((snapshotData as { error?: string }).error ?? "Failed to load contract status");
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
      setError(err instanceof Error ? err.message : "Failed to load contract status");
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dedupedBindings = useMemo(() => {
    const byKey = new Map<string, DeviceAdapterBinding>();
    for (const binding of snapshot?.bindings ?? []) {
      const key = `${binding.adapterId}:${binding.protocol}`;
      const existing = byKey.get(key);
      if (!existing || (binding.selected && !existing.selected) || binding.score > existing.score) {
        byKey.set(key, binding);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      return b.score - a.score;
    });
  }, [snapshot?.bindings]);

  const sortedServiceContracts = useMemo(() => {
    const priority = new Map<ServiceContract["criticality"], number>([["high", 0], ["medium", 1], ["low", 2]]);
    return [...(snapshot?.serviceContracts ?? [])].sort((a, b) => {
      const criticalityDiff = (priority.get(a.criticality) ?? 99) - (priority.get(b.criticality) ?? 99);
      if (criticalityDiff !== 0) return criticalityDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [snapshot]);

  const openContractFindings = useMemo(
    () => findings.filter((finding) => finding.status === "open" && ["service_contract", "service_contract_pending", "missing_credentials"].includes(finding.findingType)),
    [findings],
  );

  const selectBinding = async (binding: DeviceAdapterBinding) => {
    setMutating(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adapters/bind`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: binding.adapterId, protocol: binding.protocol }),
      }));
      const data = (await res.json()) as { bindings?: DeviceAdapterBinding[]; error?: string };
      if (!res.ok || !data.bindings) {
        throw new Error(data.error ?? "Failed to select adapter binding");
      }
      setSnapshot((prev) => (prev ? { ...prev, bindings: data.bindings ?? prev.bindings } : prev));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select adapter binding");
    } finally {
      setMutating(false);
    }
  };

  const contractMetaString = (contract: ServiceContract, key: string): string | null => {
    const value = contract.policyJson[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const contractMetaStringArray = (contract: ServiceContract, key: string): string[] => {
    const value = contract.policyJson[key];
    return Array.isArray(value) ? value.map((item) => String(item).trim()).filter((item) => item.length > 0) : [];
  };

  return (
    <Card className={cn("bg-card/85 flex min-h-0 flex-col", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Contracts</CardTitle>
            <CardDescription>Contracts and adapter bindings for this device</CardDescription>
          </div>
          <Badge variant={statusVariant(snapshot?.run?.status ?? "idle")}>{snapshot?.run?.status ?? "idle"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border bg-background/50 p-2.5"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Contracts</p><p className="text-lg font-semibold tabular-nums">{sortedServiceContracts.length}</p></div>
          <div className="rounded-md border bg-background/50 p-2.5"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Concerns</p><p className="text-lg font-semibold tabular-nums">{openContractFindings.length}</p></div>
          <div className="rounded-md border bg-background/50 p-2.5"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">High Criticality</p><p className="text-lg font-semibold tabular-nums">{sortedServiceContracts.filter((c) => c.criticality === "high").length}</p></div>
        </div>

        <p className="text-xs text-muted-foreground">
          Start or continue onboarding from the device Chat tab. Contract recommendations come from conversation.
        </p>

        <div className="space-y-2">
          <Label className="text-xs">Adapter Bindings</Label>
          {dedupedBindings.length === 0 ? <p className="text-xs text-muted-foreground">No adapter bindings suggested yet.</p> : (
            <div className="space-y-1.5">{dedupedBindings.map((binding) => (
              <div key={binding.id} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                <div><p className="font-medium">{binding.adapterId}</p><p className="text-muted-foreground">{binding.protocol} · {(binding.score * 100).toFixed(0)}%</p></div>
                <Button size="sm" variant={binding.selected ? "secondary" : "outline"} className="h-6 px-2 text-[10px]" disabled={binding.selected || mutating} onClick={() => void selectBinding(binding)}>{binding.selected ? "Selected" : "Select"}</Button>
              </div>
            ))}</div>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Contracts Steward Watches</Label>
          {sortedServiceContracts.length === 0 ? <p className="text-xs text-muted-foreground">No contracts yet. Ask in device chat to explore and propose contracts.</p> : (
            <div className="space-y-1.5">{sortedServiceContracts.map((contract) => {
              const monitorType = contractMetaString(contract, "monitorType");
              const monitorSource = contractMetaString(contract, "source");
              const lastStatus = contractMetaString(contract, "lastStatus");
              const lastEvaluatedAt = contractMetaString(contract, "lastEvaluatedAt");
              const requiredProtocols = contractMetaStringArray(contract, "requiredProtocols");
              return (
                <div key={contract.id} className="space-y-1.5 rounded-md border px-2.5 py-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5"><p className="font-medium">{contract.displayName}</p><p className="text-muted-foreground">{contract.serviceKey}</p></div>
                    <div className="flex items-center gap-1.5"><Badge variant="outline">{contract.criticality}</Badge>{lastStatus ? <Badge variant={lastStatus === "pass" ? "default" : lastStatus === "fail" ? "destructive" : "secondary"}>{lastStatus}</Badge> : null}</div>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Interval {Math.max(1, Math.floor(contract.checkIntervalSec))}s{monitorType ? ` · ${monitorType.replace(/_/g, " ")}` : ""}{monitorSource ? ` · ${monitorSource}` : ""}</p>
                    {requiredProtocols.length > 0 ? <p className="text-muted-foreground">Needs credentials: {requiredProtocols.join(", ")}</p> : null}
                    {lastEvaluatedAt ? <p className="text-muted-foreground">Last checked: {new Date(lastEvaluatedAt).toLocaleString()}</p> : null}
                  </div>
                </div>
              );
            })}</div>
          )}
        </div>

        {error ? <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
