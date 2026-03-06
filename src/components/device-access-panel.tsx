"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Puzzle, RefreshCw, Shield } from "lucide-react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AccessSurface, AdoptionRun, DeviceCredential } from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  run: AdoptionRun | null;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  accessSurfaces: AccessSurface[];
}

const CREDENTIAL_TYPE_OPTIONS = [
  "ssh",
  "winrm",
  "windows",
  "snmp",
  "http-api",
  "docker",
  "kubernetes",
  "mqtt",
  "rtsp",
  "printing",
] as const;

type DeviceAccessSection = "all" | "adapters" | "credentials";

export function DeviceAccessPanel({
  deviceId,
  className,
  section = "all",
}: {
  deviceId: string;
  className?: string;
  section?: DeviceAccessSection;
}) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentialValidating, setCredentialValidating] = useState<Record<string, boolean>>({});
  const [selectingSurface, setSelectingSurface] = useState<string | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  const [credentialType, setCredentialType] = useState<string>(CREDENTIAL_TYPE_OPTIONS[0]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingCredentialId, setDeletingCredentialId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adoption`, withClientApiToken());
      const data = (await res.json()) as AdoptionSnapshot | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to load device access");
      }
      setSnapshot(data as AdoptionSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load device access");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dedupedSurfaces = useMemo(() => {
    const byKey = new Map<string, AccessSurface>();
    for (const surface of snapshot?.accessSurfaces ?? []) {
      const key = `${surface.adapterId}:${surface.protocol}`;
      const existing = byKey.get(key);
      if (!existing || (surface.selected && !existing.selected) || surface.score > existing.score) {
        byKey.set(key, surface);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      return b.score - a.score;
    });
  }, [snapshot?.accessSurfaces]);

  const openCreateDialog = () => {
    setEditingCredentialId(null);
    setCredentialType(CREDENTIAL_TYPE_OPTIONS[0]);
    setUsername("");
    setPassword("");
    setAddDialogOpen(true);
  };

  const openEditDialog = (credential: AdoptionSnapshot["credentials"][number]) => {
    setEditingCredentialId(credential.id);
    setCredentialType(credential.protocol || CREDENTIAL_TYPE_OPTIONS[0]);
    setUsername(credential.accountLabel ?? "");
    setPassword("");
    setAddDialogOpen(true);
  };

  const submitCredential = async () => {
    if (!credentialType) return;
    if (!editingCredentialId && !password.trim()) return;
    setSaving(true);
    try {
      if (editingCredentialId) {
        const res = await fetch(
          `/api/devices/${deviceId}/credentials/${editingCredentialId}`,
          withClientApiToken({
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocol: credentialType,
              secret: password,
              accountLabel: username.trim() || undefined,
            }),
          }),
        );
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to update credential");
        }
      } else {
        const res = await fetch(`/api/devices/${deviceId}/credentials`, withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: credentialType,
            secret: password,
            accountLabel: username.trim() || undefined,
          }),
        }));
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to store credential");
        }
      }
      await refresh();
      setUsername("");
      setPassword("");
      setEditingCredentialId(null);
      setAddDialogOpen(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save credential");
    } finally {
      setSaving(false);
    }
  };

  const deleteCredential = async (credentialId: string) => {
    setDeletingCredentialId(credentialId);
    try {
      const res = await fetch(`/api/devices/${deviceId}/credentials/${credentialId}`, withClientApiToken({ method: "DELETE" }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to delete credential");
      }
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete credential");
    } finally {
      setDeletingCredentialId(null);
    }
  };

  const validateCredential = async (credentialId: string) => {
    setCredentialValidating((prev) => ({ ...prev, [credentialId]: true }));
    try {
      const res = await fetch(`/api/devices/${deviceId}/credentials/${credentialId}/validate`, withClientApiToken({ method: "POST" }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
          throw new Error(data.error ?? "Failed to mark credential as validated");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark credential as validated");
    } finally {
      setCredentialValidating((prev) => ({ ...prev, [credentialId]: false }));
    }
  };

  const selectSurface = async (surface: AccessSurface) => {
    setSelectingSurface(surface.id);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adapters/bind`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapterId: surface.adapterId, protocol: surface.protocol }),
      }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to select access surface");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select access surface");
    } finally {
      setSelectingSurface(null);
    }
  };

  const adapterCard = (
    <Card className="flex h-full min-h-0 min-w-0 flex-col bg-card/85">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Puzzle className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Adapters</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            {dedupedSurfaces.length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {dedupedSurfaces.length}
              </Badge>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
        <CardDescription>Candidate and selected adapter bindings Steward can use for this device</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {dedupedSurfaces.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <Puzzle className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No adapters proposed for this device</p>
          </div>
        ) : (
          <ul className="h-full space-y-2 overflow-auto pr-1">
            {dedupedSurfaces.map((surface) => (
              <li key={surface.id} className="flex items-center justify-between gap-3 rounded-md border bg-background/75 p-3 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{surface.adapterId}</p>
                  <p className="text-muted-foreground">
                    {surface.protocol} · {(surface.score * 100).toFixed(0)}% fit
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={surface.selected ? "secondary" : "outline"}
                  className="h-6 shrink-0 px-2 text-[10px]"
                  disabled={surface.selected || selectingSurface === surface.id}
                  onClick={() => void selectSurface(surface)}
                >
                  {surface.selected ? "Selected" : selectingSurface === surface.id ? "Selecting..." : "Select"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  const credentialsCard = (
    <Card className="flex h-full min-h-0 min-w-0 flex-col bg-card/85">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Credentials</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            {(snapshot?.credentials ?? []).length > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {snapshot?.credentials.length}
              </Badge>
            ) : null}
            {section === "credentials" ? (
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                Refresh
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={openCreateDialog}>Add Credential</Button>
          </div>
        </div>
        <CardDescription>Stored device credentials and their latest access status</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {(snapshot?.credentials ?? []).length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <Shield className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No credentials stored yet</p>
          </div>
        ) : (
          <ul className="h-full space-y-2 overflow-auto pr-1">
            {snapshot!.credentials.map((credential) => (
              <li key={credential.id} className="rounded-md border bg-background/75 p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">{credential.protocol}</p>
                    <p className="text-muted-foreground">{credential.accountLabel ?? "no username"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {credential.lastValidatedAt
                        ? `Last validated ${new Date(credential.lastValidatedAt).toLocaleString()}`
                        : "Not validated yet"}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">{credential.status}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    disabled={Boolean(credentialValidating[credential.id])}
                    onClick={() => void validateCredential(credential.id)}
                  >
                    {credentialValidating[credential.id] ? "Marking..." : "Mark Validated"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => openEditDialog(credential)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px] text-destructive"
                    disabled={deletingCredentialId === credential.id}
                    onClick={() => void deleteCredential(credential.id)}
                  >
                    {deletingCredentialId === credential.id ? "Deleting..." : "Delete"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-4", className)}>
      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {section === "all" ? (
        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-2">
          {adapterCard}
          {credentialsCard}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          {section === "adapters" ? adapterCard : credentialsCard}
        </div>
      )}

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCredentialId ? "Edit Credential" : "Add Credential"}</DialogTitle>
            <DialogDescription>
              Choose the protocol, then provide the least-privilege secret Steward should use.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Label htmlFor="cred-type">Credential Type</Label>
            <Select value={credentialType} onValueChange={setCredentialType}>
              <SelectTrigger id="cred-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CREDENTIAL_TYPE_OPTIONS.map((type) => (
                  <SelectItem key={type} value={type}>{type}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="cred-username">Username</Label>
            <Input id="cred-username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="admin" />

            <Label htmlFor="cred-password">Password / Secret</Label>
            <Input
              id="cred-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={editingCredentialId ? "Leave blank to keep current secret" : "Required"}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void submitCredential()} disabled={saving || (!editingCredentialId && !password.trim())}>
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {editingCredentialId ? "Save Changes" : "Save Credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
