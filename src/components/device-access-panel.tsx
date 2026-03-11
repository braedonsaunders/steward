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
import { Textarea } from "@/components/ui/textarea";
import type {
  AccessMethod,
  AdoptionRun,
  DeviceCredential,
  DeviceProfileBinding,
} from "@/lib/state/types";
import { protocolDisplayLabel, SUPPORTED_CREDENTIAL_PROTOCOLS } from "@/lib/protocols/catalog";
import { cn } from "@/lib/utils";

function credentialProtocolLabel(protocol: string): string {
  return protocolDisplayLabel(protocol);
}

function credentialStatusLabel(status: string): string {
  return status === "pending" ? "pending" : "stored";
}

interface AdoptionSnapshot {
  run: AdoptionRun | null;
  draft?: {
    selectedProfileIds?: string[];
    selectedAccessMethodKeys?: string[];
  } | null;
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  accessMethods: AccessMethod[];
  profiles: DeviceProfileBinding[];
}

interface AdapterRecordSummary {
  id: string;
  name: string;
  description: string;
  provides: string[];
}

const CREDENTIAL_TYPE_OPTIONS = SUPPORTED_CREDENTIAL_PROTOCOLS;

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

function selectedProfileIds(snapshot: AdoptionSnapshot | null): string[] {
  if (snapshot?.draft?.selectedProfileIds) {
    return snapshot.draft.selectedProfileIds;
  }
  return (snapshot?.profiles ?? [])
    .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
    .map((profile) => profile.profileId);
}

function csvFromArray(values: string[]): string {
  return values.join(", ");
}

function parseCsv(value: string): string[] {
  return Array.from(new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ));
}

function readErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "string" && data.trim().length > 0) {
    return data;
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return record.error;
    }
  }
  return fallback;
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
  const [pendingProfileAction, setPendingProfileAction] = useState<string | null>(null);
  const [adapterDialogOpen, setAdapterDialogOpen] = useState(false);
  const [adapterCatalog, setAdapterCatalog] = useState<AdapterRecordSummary[]>([]);
  const [adapterCatalogLoading, setAdapterCatalogLoading] = useState(false);
  const [adapterToAttach, setAdapterToAttach] = useState("");
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileKind, setProfileKind] = useState<DeviceProfileBinding["kind"]>("supporting");
  const [profileSummary, setProfileSummary] = useState("");
  const [profileRequiredAccessMethods, setProfileRequiredAccessMethods] = useState("");
  const [profileRequiredCredentialProtocols, setProfileRequiredCredentialProtocols] = useState("");

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

  const loadAdapterCatalog = useCallback(async () => {
    setAdapterCatalogLoading(true);
    try {
      const res = await fetch("/api/adapters", withClientApiToken({ cache: "no-store" }));
      const data = (await res.json()) as Array<{
        id: string;
        name: string;
        description?: string;
        provides?: string[];
      }> | { error?: string };
      if (!res.ok || !Array.isArray(data)) {
        throw new Error((data as { error?: string }).error ?? "Failed to load adapters");
      }
      const boundAdapterIds = new Set((snapshot?.profiles ?? []).map((profile) => profile.adapterId).filter((value): value is string => Boolean(value)));
      const nextCatalog = data
        .filter((adapter) => Array.isArray(adapter.provides) && adapter.provides.some((capability) => ["profile", "protocol", "enrichment"].includes(capability)))
        .filter((adapter) => !boundAdapterIds.has(adapter.id))
        .map((adapter) => ({
          id: adapter.id,
          name: adapter.name,
          description: adapter.description ?? "",
          provides: adapter.provides ?? [],
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      setAdapterCatalog(nextCatalog);
      setAdapterToAttach((current) => current || nextCatalog[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load adapters");
    } finally {
      setAdapterCatalogLoading(false);
    }
  }, [snapshot?.profiles]);

  const openAdapterDialog = async () => {
    await loadAdapterCatalog();
    setAdapterDialogOpen(true);
  };

  const updateProfileBindings = async (body: Record<string, unknown>, pendingKey: string): Promise<boolean> => {
    setPendingProfileAction(pendingKey);
    try {
      const res = await fetch(`/api/devices/${deviceId}/adapters/bind`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      const data = (await res.json()) as AdoptionSnapshot | { error?: string };
      if (!res.ok) {
        throw new Error(readErrorMessage(data, "Failed to update device adapters"));
      }
      setSnapshot(data as AdoptionSnapshot);
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update device adapters");
      return false;
    } finally {
      setPendingProfileAction(null);
    }
  };

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

  const selectProfile = async (profileId: string) => {
    const next = Array.from(new Set([...selectedProfileIds(snapshot), profileId]));
    await updateProfileBindings({ profileIds: next }, `select:${profileId}`);
  };

  const unselectProfile = async (profileId: string) => {
    const next = selectedProfileIds(snapshot).filter((candidate) => candidate !== profileId);
    await updateProfileBindings({ profileIds: next }, `unselect:${profileId}`);
  };

  const removeProfile = async (profileId: string) => {
    await updateProfileBindings({ removeProfileId: profileId }, `remove:${profileId}`);
  };

  const attachAdapter = async () => {
    if (!adapterToAttach) {
      return;
    }
    const attached = await updateProfileBindings({ attachAdapterId: adapterToAttach }, `attach:${adapterToAttach}`);
    if (attached) {
      setAdapterDialogOpen(false);
      setAdapterToAttach("");
    }
  };

  const openProfileEditor = (profile: DeviceProfileBinding) => {
    setEditingProfileId(profile.profileId);
    setProfileName(profile.name);
    setProfileKind(profile.kind);
    setProfileSummary(profile.summary);
    setProfileRequiredAccessMethods(csvFromArray(profile.requiredAccessMethods));
    setProfileRequiredCredentialProtocols(csvFromArray(profile.requiredCredentialProtocols));
    setProfileEditorOpen(true);
  };

  const saveProfileEdit = async () => {
    if (!editingProfileId) {
      return;
    }
    const nextName = profileName.trim();
    const saved = await updateProfileBindings({
      updateProfile: {
        profileId: editingProfileId,
        name: nextName.length > 0 ? nextName : undefined,
        kind: profileKind,
        summary: profileSummary.trim(),
        requiredAccessMethods: parseCsv(profileRequiredAccessMethods),
        requiredCredentialProtocols: parseCsv(profileRequiredCredentialProtocols),
      },
    }, `edit:${editingProfileId}`);
    if (saved) {
      setProfileEditorOpen(false);
      setEditingProfileId(null);
    }
  };

  const selectedAdapterRecord = adapterCatalog.find((adapter) => adapter.id === adapterToAttach) ?? null;
  const attachPending = pendingProfileAction?.startsWith("attach:") ?? false;
  const editPending = editingProfileId ? pendingProfileAction === `edit:${editingProfileId}` : false;

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
            <Button size="sm" variant="outline" onClick={() => void openAdapterDialog()} disabled={adapterCatalogLoading || loading}>
              Add Adapter
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>
        <CardDescription>Recommended, attached, and manually managed adapters for this device</CardDescription>
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
              const manual = profile.draftJson?.manualBinding === true;
              return (
                <li key={profile.id} className="rounded-md border bg-background/75 p-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{profile.name}</p>
                        <Badge variant="outline">{profile.kind}</Badge>
                        {manual ? <Badge variant="outline">manual</Badge> : null}
                        <Badge variant={profileStatusVariant(profile.status)}>{profile.status}</Badge>
                      </div>
                      <p className="text-muted-foreground">
                        {(profile.confidence * 100).toFixed(0)}% confidence
                      </p>
                      <p className="text-muted-foreground">{profile.summary}</p>
                      {profile.adapterId ? (
                        <p className="text-[10px] text-muted-foreground">Adapter: {profile.adapterId}</p>
                      ) : null}
                      {(profile.requiredAccessMethods.length > 0 || profile.requiredCredentialProtocols.length > 0) ? (
                        <p className="text-[10px] text-muted-foreground">
                          Access: {profile.requiredAccessMethods.join(", ") || "none"}
                          {" | "}
                          Credentials: {profile.requiredCredentialProtocols.join(", ") || "none"}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Button
                        size="sm"
                        variant={selected ? "secondary" : "outline"}
                        className="h-6 px-2 text-[10px]"
                        disabled={pendingProfileAction !== null}
                        onClick={() => void (selected ? unselectProfile(profile.profileId) : selectProfile(profile.profileId))}
                      >
                        {pendingProfileAction === `select:${profile.profileId}` || pendingProfileAction === `unselect:${profile.profileId}`
                          ? "Saving..."
                          : selected
                            ? "Unselect"
                            : profile.status === "rejected"
                              ? "Restore"
                              : "Select"}
                      </Button>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          disabled={pendingProfileAction !== null}
                          onClick={() => openProfileEditor(profile)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px] text-destructive"
                          disabled={pendingProfileAction !== null}
                          onClick={() => void removeProfile(profile.profileId)}
                        >
                          {pendingProfileAction === `remove:${profile.profileId}`
                            ? "Removing..."
                            : manual
                              ? "Delete"
                              : "Remove"}
                        </Button>
                      </div>
                    </div>
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
                      {method.port ? ` | :${method.port}` : ""}
                      {method.secure ? " | secure" : ""}
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
                    <p className="font-medium">{credentialProtocolLabel(credential.protocol)}</p>
                    <p className="text-muted-foreground">{credential.accountLabel ?? "no username"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Manually entered credential
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">{credentialStatusLabel(credential.status)}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
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

      <Dialog
        open={adapterDialogOpen}
        onOpenChange={(open) => {
          setAdapterDialogOpen(open);
          if (!open) {
            setAdapterToAttach("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Adapter</DialogTitle>
            <DialogDescription>
              Manually attach an adapter when auto-matching is incomplete or you want a specific profile available on this device.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div className="grid gap-2">
              <Label htmlFor="adapter-select">Adapter</Label>
              <Select value={adapterToAttach} onValueChange={setAdapterToAttach}>
                <SelectTrigger id="adapter-select">
                  <SelectValue placeholder={adapterCatalogLoading ? "Loading adapters..." : "Select an adapter"} />
                </SelectTrigger>
                <SelectContent>
                  {adapterCatalog.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>
                      {adapter.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {adapterCatalogLoading ? (
              <p className="text-xs text-muted-foreground">Loading available adapters...</p>
            ) : adapterCatalog.length === 0 ? (
              <p className="text-xs text-muted-foreground">No additional adapters are available to attach right now.</p>
            ) : selectedAdapterRecord ? (
              <div className="rounded-md border bg-muted/30 p-3 text-xs">
                <p className="font-medium">{selectedAdapterRecord.name}</p>
                <p className="mt-1 text-muted-foreground">{selectedAdapterRecord.description || "No adapter description provided."}</p>
                <p className="mt-2 text-muted-foreground">
                  Capabilities: {selectedAdapterRecord.provides.length > 0 ? selectedAdapterRecord.provides.join(", ") : "unknown"}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">Adapter ID: {selectedAdapterRecord.id}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Choose an adapter to attach it to this device.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdapterDialogOpen(false)} disabled={attachPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void attachAdapter()}
              disabled={!adapterToAttach || adapterCatalogLoading || attachPending}
            >
              {attachPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Attach Adapter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={profileEditorOpen}
        onOpenChange={(open) => {
          setProfileEditorOpen(open);
          if (!open) {
            setEditingProfileId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Adapter Binding</DialogTitle>
            <DialogDescription>
              Override how this device uses the adapter, including its role and required access paths.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div className="grid gap-2">
              <Label htmlFor="profile-name">Display Name</Label>
              <Input
                id="profile-name"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="Adapter display name"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="profile-kind">Role</Label>
              <Select value={profileKind} onValueChange={(value) => setProfileKind(value as DeviceProfileBinding["kind"])}>
                <SelectTrigger id="profile-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="primary">Primary</SelectItem>
                  <SelectItem value="supporting">Supporting</SelectItem>
                  <SelectItem value="fallback">Fallback</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="profile-summary">Summary</Label>
              <Textarea
                id="profile-summary"
                value={profileSummary}
                onChange={(event) => setProfileSummary(event.target.value)}
                placeholder="What this adapter should do on this device"
                rows={4}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="profile-access-methods">Required Access Methods</Label>
              <Input
                id="profile-access-methods"
                value={profileRequiredAccessMethods}
                onChange={(event) => setProfileRequiredAccessMethods(event.target.value)}
                placeholder="web-session, telnet"
              />
              <p className="text-[10px] text-muted-foreground">Comma-separated access method kinds such as `ssh`, `telnet`, or `web-session`.</p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="profile-credential-protocols">Required Credential Protocols</Label>
              <Input
                id="profile-credential-protocols"
                value={profileRequiredCredentialProtocols}
                onChange={(event) => setProfileRequiredCredentialProtocols(event.target.value)}
                placeholder="telnet, http-api"
              />
              <p className="text-[10px] text-muted-foreground">Comma-separated credential protocols such as `ssh`, `snmp`, `telnet`, or `http-api`.</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileEditorOpen(false)} disabled={editPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveProfileEdit()}
              disabled={!editingProfileId || editPending}
            >
              {editPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Save Binding
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                  <SelectItem key={type} value={type}>{protocolDisplayLabel(type)}</SelectItem>
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

