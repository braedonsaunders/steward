"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Package2, RefreshCw, Pencil, Search, Trash2 } from "lucide-react";
import { fetchClientJson } from "@/lib/autonomy/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

interface PackItem {
  id: string;
  name: string;
  slug: string;
  version: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  trustMode: "builtin" | "verified" | "unsigned";
  signerId?: string;
  signature?: string;
  verificationStatus?: "builtin" | "verified" | "unsigned" | "failed";
  subagentCount: number;
  missionTemplateCount: number;
  resourceCount: number;
  manifestJson: {
    slug: string;
    name: string;
    version: string;
    description: string;
    resources: Array<{
      type: string;
      key: string;
      title: string;
      description?: string;
    }>;
    tags?: string[];
  };
}

interface PackSignerItem {
  id: string;
  name: string;
  slug: string;
  enabled: boolean;
}

export default function PacksPage() {
  const [packs, setPacks] = useState<PackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingPackId, setEditingPackId] = useState<string | null>(null);
  const [savingManagedPack, setSavingManagedPack] = useState(false);
  const [removingPackId, setRemovingPackId] = useState<string | null>(null);
  const [managedTrustMode, setManagedTrustMode] = useState<"verified" | "unsigned">("unsigned");
  const [signers, setSigners] = useState<PackSignerItem[]>([]);
  const [managedSignerId, setManagedSignerId] = useState<string>("");
  const [managedSignature, setManagedSignature] = useState("");
  const [query, setQuery] = useState("");
  const [managedManifest, setManagedManifest] = useState(`{
  "slug": "community-ops-pack",
  "name": "Community Ops Pack",
  "version": "1.0.0",
  "description": "Mission templates, heuristics, and tools for a custom Steward domain.",
  "resources": [
    { "type": "mission-template", "key": "community-mission", "title": "Community Mission" }
  ],
  "tags": ["community"]
}`);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchClientJson<{ packs: PackItem[] }>("/api/packs");
      setPacks(response.packs);
      const signerResponse = await fetchClientJson<{ signers: PackSignerItem[] }>("/api/packs/signers");
      setSigners(signerResponse.signers.filter((signer) => signer.enabled));
      setManagedSignerId((current) => current || signerResponse.signers[0]?.id || "");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load packs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (pack: PackItem) => {
    setWorkingId(pack.id);
    setError(null);
    try {
      await fetchClientJson(`/api/packs/${pack.id}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          enabled: !pack.enabled,
        }),
      });
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to update pack");
    } finally {
      setWorkingId(null);
    }
  };

  const startEdit = (pack: PackItem) => {
    setEditingPackId(pack.id);
    setManagedTrustMode(pack.trustMode === "builtin" ? "verified" : pack.trustMode);
    setManagedSignerId(pack.signerId ?? signers[0]?.id ?? "");
    setManagedSignature(pack.signature ?? "");
    setManagedManifest(JSON.stringify(pack.manifestJson, null, 2));
  };

  const resetManagedPackForm = () => {
    setEditingPackId(null);
    setManagedTrustMode("unsigned");
    setManagedSignerId(signers[0]?.id ?? "");
    setManagedSignature("");
    setManagedManifest(`{
  "slug": "community-ops-pack",
  "name": "Community Ops Pack",
  "version": "1.0.0",
  "description": "Mission templates, heuristics, and tools for a custom Steward domain.",
  "resources": [
    { "type": "mission-template", "key": "community-mission", "title": "Community Mission" }
  ],
  "tags": ["community"]
}`);
  };

  const saveManagedPack = async () => {
    setSavingManagedPack(true);
    setError(null);
    try {
      const manifest = JSON.parse(managedManifest) as unknown;
      if (editingPackId) {
        await fetchClientJson(`/api/packs/${editingPackId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trustMode: managedTrustMode,
            manifest,
            signerId: managedTrustMode === "verified" ? managedSignerId : undefined,
            signature: managedTrustMode === "verified" ? managedSignature : undefined,
          }),
        });
      } else {
        await fetchClientJson("/api/packs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            trustMode: managedTrustMode,
            manifest,
            signerId: managedTrustMode === "verified" ? managedSignerId : undefined,
            signature: managedTrustMode === "verified" ? managedSignature : undefined,
          }),
        });
      }
      resetManagedPackForm();
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save managed pack");
    } finally {
      setSavingManagedPack(false);
    }
  };

  const removePack = async (packId: string) => {
    setRemovingPackId(packId);
    setError(null);
    try {
      await fetchClientJson(`/api/packs/${packId}`, {
        method: "DELETE",
      });
      if (editingPackId === packId) {
        resetManagedPackForm();
      }
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to remove pack");
    } finally {
      setRemovingPackId(null);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredPacks = packs.filter((pack) => {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = [
      pack.name,
      pack.slug,
      pack.description,
      pack.version,
      pack.verificationStatus ?? pack.trustMode,
      ...(pack.manifestJson.tags ?? []),
      ...pack.manifestJson.resources.map((resource) => `${resource.type} ${resource.title} ${resource.key}`),
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-auto pr-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Package2 className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="steward-heading-font text-2xl font-semibold tracking-tight">Packs</h1>
            <p className="text-sm text-muted-foreground">
              Installable operational knowledge bundles for missions, tools, adapters, and heuristics.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search packs" className="pl-9" />
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/30">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{editingPackId ? "Update Managed Pack" : "Install Managed Pack"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="managed-pack-trust">Trust Mode</Label>
            <Select value={managedTrustMode} onValueChange={(value: "verified" | "unsigned") => setManagedTrustMode(value)}>
              <SelectTrigger id="managed-pack-trust">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unsigned">Unsigned</SelectItem>
                <SelectItem value="verified">Verified</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {managedTrustMode === "verified" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="managed-pack-signer">Signer</Label>
                <Select value={managedSignerId} onValueChange={setManagedSignerId}>
                  <SelectTrigger id="managed-pack-signer">
                    <SelectValue placeholder="Select signer" />
                  </SelectTrigger>
                  <SelectContent>
                    {signers.map((signer) => (
                      <SelectItem key={signer.id} value={signer.id}>{signer.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="managed-pack-signature">Signature (base64)</Label>
                <Textarea
                  id="managed-pack-signature"
                  rows={4}
                  value={managedSignature}
                  onChange={(event) => setManagedSignature(event.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="managed-pack-manifest">Pack Manifest JSON</Label>
            <Textarea
              id="managed-pack-manifest"
              rows={14}
              value={managedManifest}
              onChange={(event) => setManagedManifest(event.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void saveManagedPack()} disabled={savingManagedPack}>
              {savingManagedPack ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editingPackId ? "Update Pack" : "Install Pack"}
            </Button>
            {editingPackId ? (
              <Button variant="outline" onClick={resetManagedPackForm} disabled={savingManagedPack}>
                Cancel
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {loading
          ? [1, 2].map((item) => <Skeleton key={item} className="h-56" />)
          : filteredPacks.map((pack) => (
            <Card key={pack.id}>
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">{pack.name}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{pack.description}</p>
                  </div>
                  <Badge variant={pack.enabled ? "default" : "outline"}>{pack.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{pack.version}</Badge>
                  {pack.builtin ? <Badge variant="secondary">Built-in</Badge> : null}
                  {(pack.manifestJson.tags ?? []).map((tag) => (
                    <Badge key={tag} variant="outline">{tag}</Badge>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Subagents</p>
                    <p className="mt-1 text-xl font-semibold">{pack.subagentCount}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Mission Templates</p>
                    <p className="mt-1 text-xl font-semibold">{pack.missionTemplateCount}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Resources</p>
                    <p className="mt-1 text-xl font-semibold">{pack.resourceCount}</p>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs text-muted-foreground">Trust</p>
                    <p className="mt-1 text-xl font-semibold">{pack.verificationStatus ?? pack.trustMode}</p>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={workingId === pack.id}
                    onClick={() => void toggle(pack)}
                  >
                    {workingId === pack.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    {pack.enabled ? "Disable Pack" : "Enable Pack"}
                  </Button>
                  {!pack.builtin ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Button variant="outline" onClick={() => startEdit(pack)}>
                        <Pencil className="mr-1.5 h-4 w-4" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        className="text-destructive"
                        disabled={removingPackId === pack.id}
                        onClick={() => void removePack(pack.id)}
                      >
                        {removingPackId === pack.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        {!loading && filteredPacks.length === 0 ? (
          <Card className="md:col-span-2">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No packs match the current search.
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
