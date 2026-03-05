"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { withClientApiToken } from "@/lib/auth/client-token";
import type { AuthSettings, AuthUser, UserRole } from "@/lib/state/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

type MeResponse = {
  authenticated: boolean;
  requiresBootstrap: boolean;
  mode: AuthSettings["mode"];
  usersCount: number;
  apiTokenEnabled: boolean;
  role?: UserRole;
  user?: AuthUser;
};

const roleOptions: UserRole[] = ["Owner", "Admin", "Operator", "Auditor", "ReadOnly"];

async function apiFetch<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, withClientApiToken(init));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed with ${res.status}`);
  }
  return await res.json() as T;
}

function AccessPageContent() {
  const params = useSearchParams();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [loginMethod, setLoginMethod] = useState<"local" | "ldap">("local");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [bootstrapUsername, setBootstrapUsername] = useState("owner");
  const [bootstrapDisplayName, setBootstrapDisplayName] = useState("Owner");
  const [bootstrapPassword, setBootstrapPassword] = useState("");

  const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null);
  const [oidcSecret, setOidcSecret] = useState("");
  const [ldapBindPassword, setLdapBindPassword] = useState("");
  const [users, setUsers] = useState<AuthUser[]>([]);

  const isAdmin = me?.role === "Admin" || me?.role === "Owner";
  const isOwner = me?.role === "Owner";

  const loadMe = useCallback(async () => {
    try {
      const data = await apiFetch<MeResponse>("/api/auth/me");
      setMe(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  const loadAdminData = useCallback(async () => {
    try {
      const [settingsRes, usersRes] = await Promise.all([
        apiFetch<{ settings: AuthSettings }>("/api/auth/settings"),
        apiFetch<{ users: AuthUser[] }>("/api/auth/users"),
      ]);
      setAuthSettings(settingsRes.settings);
      setUsers(usersRes.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const current = await loadMe();
      if (current?.authenticated && (current.role === "Admin" || current.role === "Owner")) {
        await loadAdminData();
      }
    })();
  }, [loadAdminData, loadMe]);

  useEffect(() => {
    const authError = params.get("auth_error");
    if (authError) {
      setError(`OIDC error: ${authError}`);
    }
  }, [params]);

  const statusBadge = useMemo(() => {
    if (!me) return null;
    if (me.authenticated) return <Badge>Signed In</Badge>;
    if (me.requiresBootstrap) return <Badge variant="destructive">Bootstrap Required</Badge>;
    return <Badge variant="secondary">Signed Out</Badge>;
  }, [me]);

  const handleBootstrap = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: bootstrapUsername,
          displayName: bootstrapDisplayName,
          password: bootstrapPassword,
        }),
      });
      setBootstrapPassword("");
      const current = await loadMe();
      if (current?.authenticated) await loadAdminData();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: loginMethod, username, password }),
      });
      setPassword("");
      const current = await loadMe();
      if (current?.authenticated && (current.role === "Admin" || current.role === "Owner")) {
        await loadAdminData();
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      setAuthSettings(null);
      setUsers([]);
      await loadMe();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOidcStart = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ ok: true; authorizeUrl: string }>("/api/auth/oidc/start");
      window.location.href = res.authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleSaveAuthSettings = async () => {
    if (!authSettings) return;
    setBusy(true);
    try {
      await apiFetch("/api/auth/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...authSettings,
          oidc: {
            ...authSettings.oidc,
            clientSecret: oidcSecret.length > 0 ? oidcSecret : undefined,
          },
          ldap: {
            ...authSettings.ldap,
            bindPassword: ldapBindPassword.length > 0 ? ldapBindPassword : undefined,
          },
        }),
      });
      setOidcSecret("");
      setLdapBindPassword("");
      await loadAdminData();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateUser = async () => {
    const generatedPassword = `Steward-${crypto.randomUUID().slice(0, 12)}!`;
    setBusy(true);
    try {
      await apiFetch("/api/auth/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: `user-${Date.now().toString().slice(-5)}`,
          displayName: "New User",
          role: "Operator",
          password: generatedPassword,
        }),
      });
      await loadAdminData();
      setError(`Created user with generated password: ${generatedPassword}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePatchUser = async (user: AuthUser, patch: Partial<Pick<AuthUser, "role" | "disabled">>) => {
    setBusy(true);
    try {
      await apiFetch(`/api/auth/users/${user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      await loadAdminData();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteUser = async (user: AuthUser) => {
    setBusy(true);
    try {
      await apiFetch(`/api/auth/users/${user.id}`, { method: "DELETE" });
      await loadAdminData();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="steward-heading-font">Access Control</CardTitle>
          <CardDescription>RBAC, local auth, OIDC SSO, and LDAP login surfaces.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          {statusBadge}
          {me?.authenticated ? (
            <span>
              Signed in as <strong>{me.user?.displayName}</strong> ({me.role})
            </span>
          ) : (
            <span>Not authenticated</span>
          )}
          {me?.authenticated ? (
            <Button variant="outline" size="sm" onClick={() => void handleLogout()} disabled={busy}>
              Sign Out
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {me?.requiresBootstrap ? (
        <Card>
          <CardHeader>
            <CardTitle>Bootstrap Owner</CardTitle>
            <CardDescription>Create the first Owner account.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label>Username</Label>
              <Input value={bootstrapUsername} onChange={(e) => setBootstrapUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Display Name</Label>
              <Input value={bootstrapDisplayName} onChange={(e) => setBootstrapDisplayName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Password</Label>
              <Input
                type="password"
                value={bootstrapPassword}
                onChange={(e) => setBootstrapPassword(e.target.value)}
              />
            </div>
            <div className="md:col-span-3">
              <Button onClick={() => void handleBootstrap()} disabled={busy || bootstrapPassword.length < 12}>
                Create Owner
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!me?.authenticated && !me?.requiresBootstrap ? (
        <Card>
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>Use local account or LDAP. OIDC redirects to your IdP.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label>Method</Label>
              <div className="flex gap-2">
                <Button
                  variant={loginMethod === "local" ? "default" : "outline"}
                  onClick={() => setLoginMethod("local")}
                  disabled={busy}
                >
                  Local
                </Button>
                <Button
                  variant={loginMethod === "ldap" ? "default" : "outline"}
                  onClick={() => setLoginMethod("ldap")}
                  disabled={busy}
                >
                  LDAP
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={() => void handleLogin()} disabled={busy || !username || !password}>
                Sign In
              </Button>
              <Button variant="outline" onClick={() => void handleOidcStart()} disabled={busy}>
                OIDC
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {me?.authenticated && isAdmin && authSettings ? (
        <Card>
          <CardHeader>
            <CardTitle>Auth Settings</CardTitle>
            <CardDescription>Mode, OIDC, and LDAP settings persisted in SQLite.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label>Mode</Label>
                <Input
                  value={authSettings.mode}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, mode: e.target.value as AuthSettings["mode"] } : prev)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Session TTL (hours)</Label>
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={authSettings.sessionTtlHours}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, sessionTtlHours: Number(e.target.value) } : prev)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>API Token</Label>
                <div className="pt-2">
                  <Badge variant={authSettings.apiTokenEnabled ? "default" : "secondary"}>
                    {authSettings.apiTokenEnabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label>OIDC Enabled</Label>
                  <Switch
                    checked={authSettings.oidc.enabled}
                    onCheckedChange={(checked) =>
                      setAuthSettings((prev) => prev ? { ...prev, oidc: { ...prev.oidc, enabled: checked } } : prev)
                    }
                  />
                </div>
                <Input
                  placeholder="Issuer URL"
                  value={authSettings.oidc.issuer}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, oidc: { ...prev.oidc, issuer: e.target.value } } : prev)
                  }
                />
                <Input
                  placeholder="Client ID"
                  value={authSettings.oidc.clientId}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, oidc: { ...prev.oidc, clientId: e.target.value } } : prev)
                  }
                />
                <Input
                  placeholder="Scopes"
                  value={authSettings.oidc.scopes}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, oidc: { ...prev.oidc, scopes: e.target.value } } : prev)
                  }
                />
                <Input
                  type="password"
                  placeholder={
                    authSettings.oidc.clientSecretConfigured
                      ? "OIDC client secret (leave blank to keep current)"
                      : "OIDC client secret"
                  }
                  value={oidcSecret}
                  onChange={(e) => setOidcSecret(e.target.value)}
                />
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label>LDAP Enabled</Label>
                  <Switch
                    checked={authSettings.ldap.enabled}
                    onCheckedChange={(checked) =>
                      setAuthSettings((prev) => prev ? { ...prev, ldap: { ...prev.ldap, enabled: checked } } : prev)
                    }
                  />
                </div>
                <Input
                  placeholder="LDAP URL (ldaps://...)"
                  value={authSettings.ldap.url}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, ldap: { ...prev.ldap, url: e.target.value } } : prev)
                  }
                />
                <Input
                  placeholder="Base DN"
                  value={authSettings.ldap.baseDn}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, ldap: { ...prev.ldap, baseDn: e.target.value } } : prev)
                  }
                />
                <Input
                  placeholder="Bind DN"
                  value={authSettings.ldap.bindDn}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, ldap: { ...prev.ldap, bindDn: e.target.value } } : prev)
                  }
                />
                <Input
                  placeholder="User filter"
                  value={authSettings.ldap.userFilter}
                  onChange={(e) =>
                    setAuthSettings((prev) => prev ? { ...prev, ldap: { ...prev.ldap, userFilter: e.target.value } } : prev)
                  }
                />
                <Input
                  type="password"
                  placeholder={
                    authSettings.ldap.bindPasswordConfigured
                      ? "LDAP bind password (leave blank to keep current)"
                      : "LDAP bind password"
                  }
                  value={ldapBindPassword}
                  onChange={(e) => setLdapBindPassword(e.target.value)}
                />
              </div>
            </div>

            <Button onClick={() => void handleSaveAuthSettings()} disabled={busy}>
              Save Auth Settings
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {me?.authenticated && isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>User Accounts</CardTitle>
            <CardDescription>Roles: Owner, Admin, Operator, Auditor, ReadOnly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isOwner ? (
              <Button variant="outline" onClick={() => void handleCreateUser()} disabled={busy}>
                Create Local User
              </Button>
            ) : null}
            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <div className="min-w-[220px]">
                    <div className="text-sm font-medium">{user.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {user.username} • {user.provider}
                    </div>
                  </div>
                  <Badge variant={user.disabled ? "secondary" : "outline"}>{user.disabled ? "Disabled" : "Active"}</Badge>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {roleOptions.map((role) => (
                      <Button
                        key={role}
                        size="sm"
                        variant={user.role === role ? "default" : "outline"}
                        onClick={() => void handlePatchUser(user, { role })}
                        disabled={busy || !isOwner}
                      >
                        {role}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handlePatchUser(user, { disabled: !user.disabled })}
                      disabled={busy || !isOwner}
                    >
                      {user.disabled ? "Enable" : "Disable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleDeleteUser(user)}
                      disabled={busy || !isOwner}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default function AccessPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
          <Card>
            <CardHeader>
              <CardTitle className="steward-heading-font">Access Control</CardTitle>
              <CardDescription>Loading access controls...</CardDescription>
            </CardHeader>
          </Card>
        </div>
      }
    >
      <AccessPageContent />
    </Suspense>
  );
}
