"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ScreenShare, SquareArrowOutUpRight } from "lucide-react";
import { DeviceRemoteTerminal } from "@/components/device-remote-terminal";
import { RemoteDesktopViewer } from "@/components/remote-desktop-viewer";
import { Button } from "@/components/ui/button";
import { withClientApiToken } from "@/lib/auth/client-token";
import type { RemoteDesktopProtocol, RemoteDesktopViewerBootstrap } from "@/lib/remote-desktop/types";
import { normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import type { AccessMethod, DeviceCredential, ProtocolSessionLease, ProtocolSessionRecord } from "@/lib/state/types";
import { cn } from "@/lib/utils";

interface DeviceRemoteDesktopPanelProps {
  deviceId: string;
  deviceName: string;
  deviceIp: string;
  protocols: string[];
  active?: boolean;
  className?: string;
}

interface AdoptionSnapshot {
  credentials: Array<Omit<DeviceCredential, "vaultSecretRef">>;
  accessMethods: AccessMethod[];
}

interface ViewerAccessResponse {
  session: ProtocolSessionRecord;
  lease: ProtocolSessionLease;
  viewerToken: string;
  viewerPath: string;
  viewerTokenExpiresAt: string;
  error?: string;
}

interface ViewerBootstrapResponse {
  bootstrap?: RemoteDesktopViewerBootstrap;
  error?: string;
}

interface LiveViewerState {
  access: ViewerAccessResponse;
  bootstrap: RemoteDesktopViewerBootstrap;
}

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;

function normalizeProtocol(value: string): RemoteDesktopProtocol | null {
  const normalized = normalizeCredentialProtocol(value);
  return normalized === "rdp" || normalized === "vnc" ? normalized : null;
}

function defaultPort(protocol: RemoteDesktopProtocol): number {
  return protocol === "rdp" ? 3389 : 5900;
}

export function DeviceRemoteDesktopPanel({
  deviceId,
  deviceName,
  deviceIp,
  protocols,
  active = true,
  className,
}: DeviceRemoteDesktopPanelProps) {
  const [snapshot, setSnapshot] = useState<AdoptionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<RemoteDesktopProtocol | "">("");
  const [viewer, setViewer] = useState<LiveViewerState | null>(null);
  const viewerRef = useRef<LiveViewerState | null>(null);
  const autoOpenKeyRef = useRef<string | null>(null);

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  const holder = `ui:manual-remote:${deviceId}`;
  const availableProtocols = useMemo(() => {
    const values = new Set<RemoteDesktopProtocol>();
    for (const value of protocols) {
      const normalized = normalizeProtocol(value);
      if (normalized) values.add(normalized);
    }
    for (const method of snapshot?.accessMethods ?? []) {
      const normalized = normalizeProtocol(method.kind) ?? normalizeProtocol(method.protocol);
      if (normalized) values.add(normalized);
    }
    return Array.from(values);
  }, [protocols, snapshot?.accessMethods]);
  const matchingAccessMethods = useMemo(
    () => (snapshot?.accessMethods ?? []).filter((entry) =>
      normalizeProtocol(entry.kind) === protocol || normalizeProtocol(entry.protocol) === protocol,
    ),
    [protocol, snapshot?.accessMethods],
  );
  const selectedPort = useMemo(() => {
    const discovered = matchingAccessMethods.find((entry) => typeof entry.port === "number" && entry.port > 0)?.port;
    return discovered ?? (protocol ? defaultPort(protocol) : undefined);
  }, [matchingAccessMethods, protocol]);

  const refresh = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      const snapshotRes = await fetch(
        `/api/devices/${deviceId}/adoption`,
        withClientApiToken({ cache: "no-store" }),
      );
      const snapshotPayload = (await snapshotRes.json()) as AdoptionSnapshot | { error?: string };
      if (!snapshotRes.ok) {
        throw new Error((snapshotPayload as { error?: string }).error ?? "Failed to load the remote access surface.");
      }
      const adoptionSnapshot = snapshotPayload as AdoptionSnapshot;
      setSnapshot({
        credentials: adoptionSnapshot.credentials ?? [],
        accessMethods: adoptionSnapshot.accessMethods ?? [],
      });
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to load the remote access surface.");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  }, [active, deviceId]);

  const releaseAccess = useCallback(async (access?: ViewerAccessResponse | null) => {
    if (!access) return;
    try {
      await fetch(`/api/protocol-sessions/${encodeURIComponent(access.session.id)}`, withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "release", leaseId: access.lease.id }),
      }));
    } catch {
      // Best-effort release. Lease expiry still limits stale holds.
    }
  }, []);

  const loadBootstrap = useCallback(async (sessionId: string, viewerToken: string) => {
    const response = await fetch(
      `/api/remote-desktop/sessions/${encodeURIComponent(sessionId)}/viewer-bootstrap`,
      withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewerToken }),
      }),
    );
    const payload = (await response.json()) as ViewerBootstrapResponse;
    if (!response.ok || !payload.bootstrap) {
      throw new Error(payload.error ?? "Failed to prepare the in-app remote desktop viewer.");
    }
    return payload.bootstrap;
  }, []);

  const requestViewerAccess = useCallback(async () => {
    if (!protocol) {
      throw new Error("No RDP or VNC surface is available for this device.");
    }

    const response = await fetch("/api/remote-desktop/sessions", withClientApiToken({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        protocol,
        host: deviceIp,
        port: selectedPort ?? defaultPort(protocol),
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        holder,
        purpose: `Manual ${protocol.toUpperCase()} session for ${deviceName}`,
        mode: "command",
        exclusive: true,
      }),
    }));
    const payload = (await response.json()) as ViewerAccessResponse;
    if (!response.ok || !payload.viewerToken) {
      throw new Error(payload.error ?? "Failed to open remote desktop session.");
    }
    return payload;
  }, [deviceId, deviceIp, deviceName, holder, protocol, selectedPort]);

  const openInline = useCallback(async () => {
    if (!protocol) return;
    setLaunching(true);
    setError(null);
    try {
      await releaseAccess(viewerRef.current?.access);
      setViewer(null);
      const access = await requestViewerAccess();
      const bootstrap = await loadBootstrap(access.session.id, access.viewerToken);
      setViewer({ access, bootstrap });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to open remote desktop session.");
    } finally {
      setLaunching(false);
    }
  }, [loadBootstrap, protocol, releaseAccess, requestViewerAccess]);

  const popOut = useCallback(async () => {
    if (viewerRef.current?.access.viewerPath) {
      window.open(viewerRef.current.access.viewerPath, "_blank", "noopener,noreferrer");
      return;
    }

    if (!protocol) {
      return;
    }

    try {
      setError(null);
      const access = await requestViewerAccess();
      window.open(access.viewerPath, "_blank", "noopener,noreferrer");
    } catch (popoutError) {
      setError(popoutError instanceof Error ? popoutError.message : "Failed to open remote desktop in a new window.");
    }
  }, [protocol, requestViewerAccess]);

  useEffect(() => {
    void releaseAccess(viewerRef.current?.access);
    setLoaded(false);
    setSnapshot(null);
    setViewer(null);
    setError(null);
    setProtocol("");
    autoOpenKeyRef.current = null;
  }, [deviceId, deviceIp, releaseAccess]);

  useEffect(() => {
    if (!loaded && active) {
      void refresh();
    }
  }, [active, loaded, refresh]);

  useEffect(() => {
    if (!protocol && availableProtocols[0]) {
      setProtocol(availableProtocols[0]);
    }
  }, [availableProtocols, protocol]);

  useEffect(() => {
    if (protocol && !availableProtocols.includes(protocol)) {
      setProtocol(availableProtocols[0] ?? "");
    }
  }, [availableProtocols, protocol]);

  useEffect(() => {
    if (!active || !protocol || availableProtocols.length === 0 || viewer || launching || loading) {
      return;
    }
    const nextKey = `${deviceId}:${protocol}`;
    if (autoOpenKeyRef.current === nextKey) {
      return;
    }
    autoOpenKeyRef.current = nextKey;
    void openInline();
  }, [active, availableProtocols.length, deviceId, launching, loading, openInline, protocol, viewer]);

  useEffect(() => () => {
    void releaseAccess(viewerRef.current?.access);
  }, [releaseAccess]);

  if (!loaded && loading && availableProtocols.length === 0 && !error) {
    return (
      <div className={cn("flex h-full min-h-0 items-center justify-center rounded-2xl border border-border/70 bg-card/80 shadow-sm", className)}>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Preparing the remote surface for this device…</span>
        </div>
      </div>
    );
  }

  if (availableProtocols.length === 0) {
    return (
      <DeviceRemoteTerminal
        deviceId={deviceId}
        deviceName={deviceName}
        active={active}
        className={className}
      />
    );
  }

  if (viewer) {
    return (
      <div className={cn("h-full min-h-0", className)}>
        <RemoteDesktopViewer
          sessionId={viewer.bootstrap.session.id}
          leaseId={viewer.bootstrap.lease.id}
          deviceName={viewer.bootstrap.deviceName}
          protocol={viewer.bootstrap.protocol}
          controlMode={viewer.bootstrap.claims.mode}
          bridgeWsUrl={viewer.bootstrap.bridgeWsUrl}
          bridgeConnectQuery={viewer.bootstrap.bridgeConnectQuery}
          initialWidth={viewer.bootstrap.config.width}
          initialHeight={viewer.bootstrap.config.height}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 items-center justify-center rounded-2xl border border-border/70 bg-card/80 shadow-sm", className)}>
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        {launching || loading ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Connecting to {protocol ? protocol.toUpperCase() : "the remote desktop"}
              </p>
              <p className="text-xs text-muted-foreground">
                Steward is preparing the in-app session for {deviceName}.
              </p>
            </div>
          </>
        ) : (
          <>
            <ScreenShare className="h-8 w-8 text-muted-foreground/50" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                {error ?? "The remote desktop surface is not ready yet."}
              </p>
              <p className="text-xs text-muted-foreground">
                Steward auto-selects the device&apos;s observed RDP or VNC surface and stored credential.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => void openInline()} disabled={!protocol || launching}>
                <ScreenShare className="mr-1.5 h-4 w-4" />
                Reconnect
              </Button>
              <Button variant="outline" onClick={() => void popOut()} disabled={!protocol}>
                <SquareArrowOutUpRight className="mr-1.5 h-4 w-4" />
                Pop Out
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
