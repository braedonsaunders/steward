"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function DeviceOnboardingPanel({
  deviceId,
  className,
  contentClassName,
}: {
  deviceId: string;
  className?: string;
  contentClassName?: string;
}) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [findings, setFindings] = useState<DeviceFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [credentialProtocol, setCredentialProtocol] = useState<string>("");
  const [credentialAccountLabel, setCredentialAccountLabel] = useState("");
  const [credentialSecret, setCredentialSecret] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialValidating, setCredentialValidating] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [snapshotRes, findingsRes] = await Promise.all([
        fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken()),
        fetch(`/api/devices/${deviceId}/findings`, withClientApiToken()),
      ]);

      const snapshotData = (await snapshotRes.json()) as AdoptionSnapshot | { error?: string };
      if (!snapshotRes.ok) {
        throw new Error((snapshotData as { error?: string }).error ?? "Failed to load onboarding status");
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
      setError(err instanceof Error ? err.message : "Failed to load onboarding status");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const unresolvedQuestions = useMemo(
    () => (snapshot?.questions ?? []).filter((question) => !question.answerJson),
    [snapshot],
  );

  const sortedServiceContracts = useMemo(() => {
    const priority = new Map<ServiceContract["criticality"], number>([
      ["high", 0],
      ["medium", 1],
      ["low", 2],
    ]);

    return [...(snapshot?.serviceContracts ?? [])].sort((a, b) => {
      const criticalityDiff = (priority.get(a.criticality) ?? 99) - (priority.get(b.criticality) ?? 99);
      if (criticalityDiff !== 0) return criticalityDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [snapshot]);

  const openContractFindings = useMemo(
    () => findings.filter(
      (finding) =>
        finding.status === "open" &&
        (finding.findingType === "service_contract"
          || finding.findingType === "service_contract_pending"
          || finding.findingType === "missing_credentials"),
    ),
    [findings],
  );

  const credentialProtocols = useMemo(() => {
    const protocols = new Set<string>();

    const profileRaw = snapshot?.run?.profileJson;
    const profile = profileRaw && typeof profileRaw === "object"
      ? (profileRaw as { credentialIntents?: Array<{ protocol?: string }> })
      : undefined;
    for (const intent of profile?.credentialIntents ?? []) {
      if (intent?.protocol && intent.protocol.trim().length > 0) {
        protocols.add(intent.protocol.trim().toLowerCase());
      }
    }

    for (const binding of snapshot?.bindings ?? []) {
      if (binding.protocol?.trim().length > 0) {
        protocols.add(binding.protocol.trim().toLowerCase());
      }
    }

    return Array.from(protocols).sort();
  }, [snapshot]);

  useEffect(() => {
    if (!credentialProtocol && credentialProtocols.length > 0) {
      setCredentialProtocol(credentialProtocols[0]);
    }
  }, [credentialProtocol, credentialProtocols]);

  const startOnboarding = async (force = false) => {
    setMutating(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      }));
      const data = (await res.json()) as AdoptionSnapshot | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to start onboarding");
      }
      setSnapshot(data as AdoptionSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start onboarding");
    } finally {
      setMutating(false);
    }
  };

  const answerQuestion = async (question: AdoptionQuestion) => {
    const answer = questionDrafts[question.id]?.trim();
    if (!answer) return;

    setMutating(true);
    try {
      const res = await fetch(
        `/api/devices/${deviceId}/adoption/questions/${question.id}/answer`,
        withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: { selection: answer } }),
        }),
      );
      const data = (await res.json()) as { snapshot?: AdoptionSnapshot; error?: string };
      if (!res.ok || !data.snapshot) {
        throw new Error(data.error ?? "Failed to answer onboarding question");
      }
      setQuestionDrafts((prev) => {
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
      setSnapshot(data.snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to answer onboarding question");
    } finally {
      setMutating(false);
    }
  };

  const submitCredential = async () => {
    if (!credentialProtocol || !credentialSecret.trim()) return;

    setCredentialSaving(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/credentials`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: credentialProtocol,
          secret: credentialSecret,
          accountLabel: credentialAccountLabel || undefined,
          validateNow: true,
        }),
      }));
      const data = (await res.json()) as { snapshot?: AdoptionSnapshot; error?: string };
      if (!res.ok || !data.snapshot) {
        throw new Error(data.error ?? "Failed to store credential");
      }
      setCredentialSecret("");
      setCredentialAccountLabel("");
      setSnapshot(data.snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to store credential");
    } finally {
      setCredentialSaving(false);
    }
  };

  const validateCredential = async (credentialId: string) => {
    setCredentialValidating((prev) => ({ ...prev, [credentialId]: true }));
    try {
      const res = await fetch(
        `/api/devices/${deviceId}/credentials/${credentialId}/validate`,
        withClientApiToken({ method: "POST" }),
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to validate credential");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to validate credential");
    } finally {
      setCredentialValidating((prev) => ({ ...prev, [credentialId]: false }));
    }
  };

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
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    return value.trim();
  };

  const contractMetaStringArray = (contract: ServiceContract, key: string): string[] => {
    const value = contract.policyJson[key];
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  };

  const contractStatusVariant = (status: string | null): "default" | "destructive" | "secondary" | "outline" => {
    if (status === "pass") return "default";
    if (status === "fail") return "destructive";
    if (status === "pending" || status === "pending_credentials") return "secondary";
    return "outline";
  };

  const severityVariant = (
    severity: DeviceFinding["severity"],
  ): "default" | "destructive" | "secondary" | "outline" => {
    if (severity === "critical") return "destructive";
    if (severity === "warning") return "secondary";
    return "outline";
  };

  return (
    <Card className={cn("bg-card/85 flex min-h-0 flex-col", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Contracts & Onboarding</CardTitle>
            <CardDescription>Service contracts, credential onboarding, and adapter bindings</CardDescription>
          </div>
          <Badge variant={statusVariant(snapshot?.run?.status ?? "idle")}>
            {snapshot?.run?.status ?? "idle"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className={cn("min-h-0 flex-1 space-y-4 overflow-auto pr-1", contentClassName)}>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Contracts</p>
            <p className="text-lg font-semibold tabular-nums">{sortedServiceContracts.length}</p>
          </div>
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Concerns</p>
            <p className="text-lg font-semibold tabular-nums">{openContractFindings.length}</p>
          </div>
          <div className="rounded-md border bg-background/50 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">High Criticality</p>
            <p className="text-lg font-semibold tabular-nums">
              {sortedServiceContracts.filter((contract) => contract.criticality === "high").length}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void startOnboarding(false)}
            disabled={mutating || loading}
          >
            {mutating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Start Onboarding
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startOnboarding(true)}
            disabled={mutating || loading}
          >
            Re-run Profile
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        {snapshot?.run?.summary ? (
          <div className="rounded-md border bg-background/50 p-2.5 text-xs text-muted-foreground">
            {snapshot.run.summary}
          </div>
        ) : null}

        {unresolvedQuestions.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-xs">Onboarding Questions</Label>
            {unresolvedQuestions.map((question) => (
              <div key={question.id} className="rounded-md border p-2.5 text-xs">
                <p className="mb-2 font-medium">{question.prompt}</p>
                {question.options.length > 0 ? (
                  <Select
                    value={questionDrafts[question.id] ?? ""}
                    onValueChange={(value) =>
                      setQuestionDrafts((prev) => ({ ...prev, [question.id]: value }))
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Select an answer" />
                    </SelectTrigger>
                    <SelectContent>
                      {question.options.map((option) => (
                        <SelectItem key={`${question.id}:${option.value}`} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={questionDrafts[question.id] ?? ""}
                    onChange={(event) =>
                      setQuestionDrafts((prev) => ({ ...prev, [question.id]: event.target.value }))
                    }
                    placeholder="Enter your answer"
                    className="h-8 text-xs"
                  />
                )}
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={mutating || !(questionDrafts[question.id] ?? "").trim()}
                    onClick={() => void answerQuestion(question)}
                  >
                    Submit
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {snapshot?.run ? "No unresolved onboarding questions." : "Onboarding has not started yet."}
          </p>
        )}

        <div className="space-y-2">
          <Label className="text-xs">Credentials</Label>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
            <Select value={credentialProtocol} onValueChange={setCredentialProtocol}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Protocol" />
              </SelectTrigger>
              <SelectContent>
                {credentialProtocols.length > 0 ? (
                  credentialProtocols.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>
                      {protocol}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="ssh">ssh</SelectItem>
                )}
              </SelectContent>
            </Select>
            <Input
              className="h-8 text-xs"
              placeholder="Account label (optional)"
              value={credentialAccountLabel}
              onChange={(event) => setCredentialAccountLabel(event.target.value)}
            />
          </div>
          <Input
            className="h-8 text-xs"
            type="password"
            placeholder="Credential secret"
            value={credentialSecret}
            onChange={(event) => setCredentialSecret(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={credentialSaving || !credentialProtocol || !credentialSecret.trim()}
              onClick={() => void submitCredential()}
            >
              {credentialSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Store Credential
            </Button>
          </div>

          {(snapshot?.credentials ?? []).length > 0 ? (
            <div className="space-y-1.5">
              {snapshot?.credentials.map((credential) => (
                <div key={credential.id} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                  <div>
                    <p className="font-medium">{credential.protocol}</p>
                    <p className="text-muted-foreground">{credential.accountLabel ?? "no label"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{credential.status}</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      disabled={Boolean(credentialValidating[credential.id])}
                      onClick={() => void validateCredential(credential.id)}
                    >
                      {credentialValidating[credential.id] ? "Validating..." : "Validate"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label className="text-xs">Adapter Bindings</Label>
          {(snapshot?.bindings ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No adapter bindings suggested yet.</p>
          ) : (
            <div className="space-y-1.5">
              {snapshot?.bindings.map((binding) => (
                <div key={binding.id} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                  <div>
                    <p className="font-medium">{binding.adapterId}</p>
                    <p className="text-muted-foreground">
                      {binding.protocol} · {(binding.score * 100).toFixed(0)}%
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={binding.selected ? "secondary" : "outline"}
                    className="h-6 px-2 text-[10px]"
                    disabled={binding.selected || mutating}
                    onClick={() => void selectBinding(binding)}
                  >
                    {binding.selected ? "Selected" : "Select"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {sortedServiceContracts.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-xs">Contracts Steward Watches</Label>
            <div className="space-y-1.5">
              {sortedServiceContracts.map((contract) => {
                const monitorType = contractMetaString(contract, "monitorType");
                const monitorSource = contractMetaString(contract, "source");
                const lastStatus = contractMetaString(contract, "lastStatus");
                const lastEvaluatedAt = contractMetaString(contract, "lastEvaluatedAt");
                const requiredProtocols = contractMetaStringArray(contract, "requiredProtocols");

                return (
                <div key={contract.id} className="space-y-1.5 rounded-md border px-2.5 py-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <p className="font-medium">{contract.displayName}</p>
                      <p className="text-muted-foreground">{contract.serviceKey}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{contract.criticality}</Badge>
                      {lastStatus ? (
                        <Badge variant={contractStatusVariant(lastStatus)}>{lastStatus}</Badge>
                      ) : null}
                    </div>
                  </div>
                  <div>
                    <p className="text-muted-foreground">
                      Interval {Math.max(1, Math.floor(contract.checkIntervalSec))}s
                      {monitorType ? ` · ${monitorType.replace(/_/g, " ")}` : ""}
                      {monitorSource ? ` · ${monitorSource}` : ""}
                    </p>
                    {requiredProtocols.length > 0 ? (
                      <p className="text-muted-foreground">Needs credentials: {requiredProtocols.join(", ")}</p>
                    ) : null}
                    {lastEvaluatedAt ? (
                      <p className="text-muted-foreground">Last checked: {new Date(lastEvaluatedAt).toLocaleString()}</p>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {openContractFindings.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-xs">Active Contract Concerns</Label>
            <div className="space-y-1.5">
              {openContractFindings.map((finding) => (
                <div key={finding.id} className="rounded-md border px-2.5 py-2 text-xs">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <p className="font-medium">{finding.title}</p>
                    <Badge variant={severityVariant(finding.severity)}>{finding.severity}</Badge>
                  </div>
                  <p className="text-muted-foreground">{finding.summary}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
