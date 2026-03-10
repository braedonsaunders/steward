import type { ProtocolSessionLease, ProtocolSessionRecord } from "@/lib/state/types";

export type RemoteDesktopProtocol = "rdp" | "vnc";
export type RemoteDesktopControlMode = "observe" | "command";

export interface RemoteDesktopSessionConfig {
  host: string;
  port: number;
  credentialId?: string;
  accountLabel?: string;
  width: number;
  height: number;
  dpi: number;
  ignoreCertificateErrors: boolean;
  colorDepth: number;
  readOnlyDefault: boolean;
  liveConnectionId?: string;
}

export interface RemoteDesktopViewerClaims {
  sessionId: string;
  leaseId: string;
  holder: string;
  mode: RemoteDesktopControlMode;
  exp: number;
}

export interface RemoteDesktopViewerAccess {
  session: ProtocolSessionRecord;
  lease: ProtocolSessionLease;
  viewerToken: string;
  viewerTokenExpiresAt: string;
  viewerPath: string;
}

export interface RemoteDesktopViewerBootstrap {
  session: ProtocolSessionRecord;
  lease: ProtocolSessionLease;
  claims: RemoteDesktopViewerClaims;
  bridgeWsUrl: string;
  bridgeConnectQuery: string;
  deviceName: string;
  protocol: RemoteDesktopProtocol;
  config: RemoteDesktopSessionConfig;
}
