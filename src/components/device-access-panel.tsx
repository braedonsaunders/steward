"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Puzzle, RefreshCw, Shield, Waypoints } from "lucide-react";
import { withClientApiToken } from "@/lib/auth/client-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type {
  AccessMethod,
  AdoptionRun,
  DeviceCredential,
  DeviceProfileBinding,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface AdoptionSnapshot {
  run: AdoptionRun | null;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  accessMethods: AccessMethod[];
  profiles: DeviceProfileBinding[];
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

function profileStatusVariant(status: DeviceProfileBinding["status"]): "default" | "secondary" | "outline" {
  if (status === "active" || status === "verified") return "default";
  if (status === "selected") return "secondary";
  return "outline";
}

function accessStatusVariant(status: AccessMethod["status"]): "default" | "secondary" | "outline" {
  if (status === "validated") return "default";
  if (status === "credentialed") return "secondary";
  return "outline";
}

export function DeviceAccessPanel({
  deviceId,
  active = true,
  className,
  section = "all",
}: {
  deviceId: string;
  active?: boolean;
  className?: string;
  section?: DeviceAccessSection;
}) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [credentialValidating, setCredentialValidating] = useState<Record<string, boolean>>({});
  const [selectingProfileId, setSelectingProfileId] = useState<string | null>(null);

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
      setHasLoaded(true);
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setHasLoaded(false);
    setLoading(true);
  }, [deviceId]);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void refresh();
  }, [active, hasLoaded, refresh]);

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

  const selectProfile = async (profileId: string) => {
    setSelectingProfileId(profileId);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adapters/bind`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profileId }),
      }));
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to select adapter");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select adapter");
    } finally {
      setSelectingProfileId(null);
    }
  };

  const profileCard = (
    <Card className="flex h-full min-h-0 min-w-0 flex-col bg-card/85">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Puzzle className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Adapters</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            {(snapshot?.profiles.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {snapshot?.profiles.length}
              </Badge>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
        <CardDescription>First-party or fallback adapters Steward can credibly use to manage this device</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {(snapshot?.profiles.length ?? 0) === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <Puzzle className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No adapters matched this device yet</p>
          </div>
        ) : (
          <ul className="h-full space-y-2 overflow-auto pr-1">
            {snapshot!.profiles.map((profile) => {
              const selected = ["selected", "verified", "active"].includes(profile.status);
              return (
                <li key={profile.id} className="rounded-md border bg-background/75 p-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{profile.name}</p>
                        <Badge variant="outline">{profile.kind}</Badge>
                        <Badge variant={profileStatusVariant(profile.status)}>{profile.status}</Badge>
                      </div>
                      <p className="text-muted-foreground">
                        {(profile.confidence * 100).toFixed(0)}% confidence
                      </p>
                      <p className="text-muted-foreground">{profile.summary}</p>
                      {(profile.requiredAccessMethods.length > 0 || profile.requiredCredentialProtocols.length > 0) ? (
                        <p className="text-[10px] text-muted-foreground">
                          Access: {profile.requiredAccessMethods.join(", ") || "none"}
                          {" · "}
                          Credentials: {profile.requiredCredentialProtocols.join(", ") || "none"}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant={selected ? "secondary" : "outline"}
                      className="h-6 shrink-0 px-2 text-[10px]"
                      disabled={selected || selectingProfileId === profile.profileId}
                      onClick={() => void selectProfile(profile.profileId)}
                    >
                      {selected ? (profile.status === "active" ? "Active" : "Selected") : selectingProfileId === profile.profileId ? "Selecting..." : "Select"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  const accessMethodsCard = (
    <Card className="flex h-full min-h-0 min-w-0 flex-col bg-card/85">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Waypoints className="size-4 text-muted-foreground" />
          <CardTitle className="text-base">Access Methods</CardTitle>
          <div className="ml-auto flex items-center gap-2">
            {(snapshot?.accessMethods.length ?? 0) > 0 ? (
              <Badge variant="secondary" className="tabular-nums">
                {snapshot?.accessMethods.length}
              </Badge>
            ) : null}
          </div>
        </div>
        <CardDescription>Observed or accepted management surfaces Steward can reach on this device</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {(snapshot?.accessMethods.length ?? 0) === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
            <Waypoints className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No management surfaces observed yet</p>
          </div>
        ) : (
          <ul className="h-full space-y-2 overflow-auto pr-1">
            {snapshot!.accessMethods.map((method) => (
              <li key={method.id} className="rounded-md border bg-background/75 p-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{method.title}</p>
                      {method.selected ? <Badge variant="secondary">Selected</Badge> : null}
                      <Badge variant={accessStatusVariant(method.status)}>{method.status}</Badge>
                    </div>
                    <p className="text-muted-foreground">
                      {method.protocol}
                      {method.port ? ` · :${method.port}` : ""}
                      {method.secure ? " · secure" : ""}
                    </p>
                    {method.summary ? (
                      <p className="text-muted-foreground">{method.summary}</p>
                    ) : null}
                  </div>
                </div>
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
        <CardDescription>Stored device credentials and their latest access state</CardDescription>
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
        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-3">
          {profileCard}
          {accessMethodsCard}
          {credentialsCard}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          {section === "adapters" ? profileCard : credentialsCard}
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
