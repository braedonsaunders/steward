"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AdoptionRun, DeviceAdapterBinding, DeviceCredential } from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  run: AdoptionRun | null;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  bindings: DeviceAdapterBinding[];
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

export function DeviceCredentialsPanel({ deviceId, className }: { deviceId: string; className?: string }) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentialValidating, setCredentialValidating] = useState<Record<string, boolean>>({});

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
        throw new Error((data as { error?: string }).error ?? "Failed to load credentials");
      }
      setSnapshot(data as AdoptionSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load credentials");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
              validateNow: true,
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
            validateNow: true,
          }),
        }));
        const data = (await res.json()) as { snapshot?: AdoptionSnapshot; error?: string };
        if (!res.ok || !data.snapshot) {
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
        throw new Error(data.error ?? "Failed to validate credential");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to validate credential");
    } finally {
      setCredentialValidating((prev) => ({ ...prev, [credentialId]: false }));
    }
  };

  return (
    <Card className={cn("bg-card/85", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Credentials</CardTitle>
            <CardDescription>Add and validate credential access for this device</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={openCreateDialog}>Add Credential</Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Stored Credentials</Label>
          {(snapshot?.credentials ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No credentials stored yet.</p>
          ) : (
            snapshot!.credentials.map((credential) => (
              <div key={credential.id} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                <div>
                  <p className="font-medium">{credential.protocol}</p>
                  <p className="text-muted-foreground">{credential.accountLabel ?? "no username"}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {credential.lastValidatedAt
                      ? `Last validated ${new Date(credential.lastValidatedAt).toLocaleString()}`
                      : "Not validated yet"}
                  </p>
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
              </div>
            ))
          )}
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">{error}</p>
        ) : null}
      </CardContent>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCredentialId ? "Edit Credential" : "Add Credential"}</DialogTitle>
            <DialogDescription>
              Choose credential type and provide username/password.
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
    </Card>
  );
}
