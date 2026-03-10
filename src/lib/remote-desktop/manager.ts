import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import net from "node:net";
import { normalizeCredentialProtocol } from "@/lib/protocols/catalog";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type {
  Device,
  DeviceCredential,
  ProtocolSessionLease,
  ProtocolSessionRecord,
} from "@/lib/state/types";
import type {
  RemoteDesktopControlMode,
  RemoteDesktopProtocol,
  RemoteDesktopSessionConfig,
  RemoteDesktopViewerAccess,
  RemoteDesktopViewerBootstrap,
  RemoteDesktopViewerClaims,
} from "@/lib/remote-desktop/types";

const REMOTE_DESKTOP_PROTOCOLS = new Set<RemoteDesktopProtocol>(["rdp", "vnc"]);
const DEFAULT_RDP_PORT = 3389;
const DEFAULT_VNC_PORT = 5900;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const DEFAULT_DPI = 96;
const DEFAULT_COLOR_DEPTH = 24;
const DEFAULT_VIEWER_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 45 * 60 * 1000;
const GUACD_PORT = 4822;
const GUACD_HOST_CANDIDATES = ["guacd", "127.0.0.1", "localhost"] as const;
const BRIDGE_CIPHER_SECRET_REF = "remote_desktop.bridge_cipher_key";
const VIEWER_SIGNING_SECRET_REF = "remote_desktop.viewer_signing_key";

interface ViewerAccessOptions {
  holder: string;
  purpose: string;
  mode?: RemoteDesktopControlMode;
  exclusive?: boolean;
  leaseTtlMs?: number;
  viewerTtlMs?: number;
}

interface OpenSessionArgs extends ViewerAccessOptions {
  device: Device;
  protocol?: RemoteDesktopProtocol;
  credentialId?: string;
  host?: string;
  port?: number;
  width?: number;
  height?: number;
  dpi?: number;
  sessionId?: string;
}

interface GuacamoleLiteConnectionEvent {
  query?: Record<string, unknown>;
  guacamoleConnectionId?: string;
}

interface GuacamoleLiteServer {
  on: <TArgs extends unknown[]>(event: string, handler: (...args: TArgs) => void) => void;
  close?: () => void;
}

interface BridgeRuntimeState {
  server: GuacamoleLiteServer | null;
  startPromise: Promise<void> | null;
  guacdHost: string | null;
  viewerCounts: Map<string, number>;
  port: number;
}

class RemoteDesktopConflictError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRemoteDesktopProtocol(value: unknown): RemoteDesktopProtocol | null {
  const normalized = normalizeCredentialProtocol(typeof value === "string" ? value : "");
  return REMOTE_DESKTOP_PROTOCOLS.has(normalized as RemoteDesktopProtocol)
    ? normalized as RemoteDesktopProtocol
    : null;
}

function remoteDesktopSessionSummary(device: Device, protocol: RemoteDesktopProtocol, host: string, port: number): string {
  return `${protocol.toUpperCase()} ${host}:${port} for ${device.name}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function resolveInternalAppPort(): number {
  return clampInt(process.env.PORT, 1024, 65535, 3010);
}

function resolveInternalBridgePort(): number {
  return resolveInternalAppPort() + 1;
}

function buildViewerPath(sessionId: string, viewerToken: string): string {
  return `/remote-desktop/${encodeURIComponent(sessionId)}?viewerToken=${encodeURIComponent(viewerToken)}`;
}

function buildAbsoluteUrl(origin: string, path: string): string {
  return new URL(path, origin.endsWith("/") ? origin : `${origin}/`).toString();
}

function localStewardOrigin(): string {
  return `http://127.0.0.1:${resolveInternalAppPort()}`;
}

function sanitizeSessionId(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function defaultPort(protocol: RemoteDesktopProtocol): number {
  return protocol === "rdp" ? DEFAULT_RDP_PORT : DEFAULT_VNC_PORT;
}

function parseRemoteDesktopAccountLabel(value?: string): { username?: string; domain?: string } {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return {};
  }

  const parts = trimmed.split("\\");
  if (parts.length >= 2) {
    const domain = parts.shift()?.trim();
    const username = parts.join("\\").trim();
    return {
      ...(username.length > 0 ? { username } : {}),
      ...(domain && domain.length > 0 ? { domain } : {}),
    };
  }

  return { username: trimmed };
}

function buildSessionId(args: {
  deviceId: string;
  protocol: RemoteDesktopProtocol;
  host: string;
  port: number;
  credentialId?: string;
}): string {
  return `remote-${sanitizeSessionId([
    args.deviceId,
    args.protocol,
    args.host,
    String(args.port),
    args.credentialId ?? "none",
  ].join("|"))}`;
}

function readRemoteDesktopSessionConfig(session: ProtocolSessionRecord): RemoteDesktopSessionConfig {
  const raw = isRecord(session.configJson) ? session.configJson : {};
  return {
    host: typeof raw.host === "string" && raw.host.trim().length > 0 ? raw.host.trim() : "",
    port: clampInt(raw.port, 1, 65535, defaultPort(session.protocol as RemoteDesktopProtocol)),
    credentialId: typeof raw.credentialId === "string" && raw.credentialId.trim().length > 0
      ? raw.credentialId.trim()
      : undefined,
    accountLabel: typeof raw.accountLabel === "string" && raw.accountLabel.trim().length > 0
      ? raw.accountLabel.trim()
      : undefined,
    width: clampInt(raw.width, 640, 4096, DEFAULT_WIDTH),
    height: clampInt(raw.height, 480, 4096, DEFAULT_HEIGHT),
    dpi: clampInt(raw.dpi, 72, 300, DEFAULT_DPI),
    ignoreCertificateErrors: raw.ignoreCertificateErrors !== false,
    colorDepth: clampInt(raw.colorDepth, 8, 32, DEFAULT_COLOR_DEPTH),
    readOnlyDefault: raw.readOnlyDefault === true,
    liveConnectionId: typeof raw.liveConnectionId === "string" && raw.liveConnectionId.trim().length > 0
      ? raw.liveConnectionId.trim()
      : undefined,
  };
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.isBuffer(value)
    ? value.toString("base64url")
    : Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

async function ensureSecretBuffer(secretRef: string, length: number): Promise<Buffer> {
  const existing = await vault.getSecret(secretRef);
  if (existing && existing.trim().length > 0) {
    const decoded = Buffer.from(existing, "base64");
    if (decoded.byteLength === length) {
      return decoded;
    }
  }

  const generated = randomBytes(length);
  await vault.setSecret(secretRef, generated.toString("base64"));
  return generated;
}

function signViewerPayload(payloadBase64: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

async function issueViewerToken(claims: RemoteDesktopViewerClaims): Promise<string> {
  const secret = await ensureSecretBuffer(VIEWER_SIGNING_SECRET_REF, 32);
  const payloadBase64 = toBase64Url(JSON.stringify(claims));
  const signature = signViewerPayload(payloadBase64, secret);
  return `${payloadBase64}.${signature}`;
}

async function verifyViewerToken(token: string): Promise<RemoteDesktopViewerClaims> {
  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) {
    throw new Error("Viewer token is malformed.");
  }

  const secret = await ensureSecretBuffer(VIEWER_SIGNING_SECRET_REF, 32);
  const expected = Buffer.from(signViewerPayload(payloadBase64, secret), "utf8");
  const received = Buffer.from(signature, "utf8");
  if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
    throw new Error("Viewer token signature is invalid.");
  }

  const payload = JSON.parse(fromBase64Url(payloadBase64).toString("utf8")) as Partial<RemoteDesktopViewerClaims>;
  if (
    typeof payload.sessionId !== "string"
    || typeof payload.leaseId !== "string"
    || typeof payload.holder !== "string"
    || (payload.mode !== "observe" && payload.mode !== "command")
    || !Number.isFinite(Number(payload.exp))
  ) {
    throw new Error("Viewer token payload is invalid.");
  }

  const claims: RemoteDesktopViewerClaims = {
    sessionId: payload.sessionId,
    leaseId: payload.leaseId,
    holder: payload.holder,
    mode: payload.mode,
    exp: Number(payload.exp),
  };
  if (claims.exp <= Date.now()) {
    throw new Error("Viewer token has expired.");
  }

  return claims;
}

function encryptGuacamoleToken(payload: Record<string, unknown>, secret: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", secret, iv);
  let encrypted = cipher.update(JSON.stringify(payload), "utf8", "base64");
  encrypted += cipher.final("base64");
  return Buffer.from(JSON.stringify({
    iv: iv.toString("base64"),
    value: encrypted,
  }), "utf8").toString("base64");
}

async function probeTcpHost(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function resolveGuacdHost(): Promise<string> {
  for (const candidate of GUACD_HOST_CANDIDATES) {
    if (await probeTcpHost(candidate, GUACD_PORT)) {
      return candidate;
    }
  }
  return "127.0.0.1";
}

function selectCredential(deviceId: string, protocol: RemoteDesktopProtocol, credentialId?: string): DeviceCredential | undefined {
  const candidates = stateStore.getDeviceCredentials(deviceId)
    .filter((credential) => normalizeCredentialProtocol(credential.protocol) === protocol);
  if (credentialId) {
    return candidates.find((credential) => credential.id === credentialId);
  }

  const priority = ["validated", "provided", "invalid", "pending"] as const;
  return [...candidates].sort((left, right) => {
    const leftPriority = priority.indexOf(left.status as (typeof priority)[number]);
    const rightPriority = priority.indexOf(right.status as (typeof priority)[number]);
    if (leftPriority !== rightPriority) {
      return (leftPriority === -1 ? 99 : leftPriority) - (rightPriority === -1 ? 99 : rightPriority);
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  })[0];
}

function resolveProtocolForDevice(device: Device, requested?: RemoteDesktopProtocol): RemoteDesktopProtocol {
  if (requested) {
    const present = device.protocols.some((protocol) => normalizeCredentialProtocol(protocol) === requested)
      || stateStore.getAccessMethods(device.id).some((method) => normalizeCredentialProtocol(method.kind) === requested);
    if (!present) {
      throw new Error(`${requested.toUpperCase()} is not an observed management surface for ${device.name}.`);
    }
    return requested;
  }

  if (device.protocols.some((protocol) => normalizeCredentialProtocol(protocol) === "rdp")) {
    return "rdp";
  }
  if (device.protocols.some((protocol) => normalizeCredentialProtocol(protocol) === "vnc")) {
    return "vnc";
  }
  if (stateStore.getAccessMethods(device.id).some((method) => normalizeCredentialProtocol(method.kind) === "rdp")) {
    return "rdp";
  }
  if (stateStore.getAccessMethods(device.id).some((method) => normalizeCredentialProtocol(method.kind) === "vnc")) {
    return "vnc";
  }

  throw new Error(`No browser-manageable remote desktop surface was found for ${device.name}.`);
}

function activeLeasesForSession(sessionId: string): ProtocolSessionLease[] {
  const now = Date.now();
  return stateStore.getProtocolSessionLeases({ sessionId, status: "active" })
    .filter((lease) => new Date(lease.expiresAt).getTime() > now)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

function acquireLease(session: ProtocolSessionRecord, options: ViewerAccessOptions): ProtocolSessionLease {
  protocolSessionManager.expireStaleLeases();

  const current = activeLeasesForSession(session.id);
  const requestedMode: ProtocolSessionLease["mode"] = options.mode === "observe" ? "observe" : "command";
  const exclusive = options.exclusive ?? requestedMode === "command";
  const conflicting = current.find((lease) =>
    lease.holder !== options.holder
    && (
      session.arbitrationMode !== "shared"
      || exclusive
      || lease.exclusive
    ));
  if (conflicting) {
    throw new RemoteDesktopConflictError(
      `${session.summary ?? session.id} is already leased by ${conflicting.holder}.`,
    );
  }

  const nowMs = Date.now();
  const runtime = stateStore.getRuntimeSettings();
  const ttlMs = Math.min(
    Math.max(10_000, options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS),
    runtime.protocolSessionMaxLeaseTtlMs,
  );
  const existing = current.find((lease) => lease.holder === options.holder && lease.mode === requestedMode);

  const lease: ProtocolSessionLease = {
    id: existing?.id ?? `remote-lease-${sanitizeSessionId(`${session.id}|${options.holder}|${requestedMode}`)}`,
    sessionId: session.id,
    holder: options.holder,
    purpose: options.purpose,
    mode: requestedMode,
    status: "active",
    exclusive,
    requestedAt: existing?.requestedAt ?? nowIso(),
    grantedAt: nowIso(),
    releasedAt: undefined,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    metadataJson: {
      ...(existing?.metadataJson ?? {}),
      remoteDesktop: true,
      mode: options.mode ?? "command",
    },
  };

  stateStore.upsertProtocolSessionLease(lease);
  stateStore.upsertProtocolSession({
    ...session,
    desiredState: "active",
    activeLeaseId: lease.id,
    updatedAt: nowIso(),
  });

  return lease;
}

function updateSession(session: ProtocolSessionRecord, patch: Partial<ProtocolSessionRecord>): ProtocolSessionRecord {
  return stateStore.upsertProtocolSession({
    ...session,
    ...patch,
    updatedAt: nowIso(),
  });
}

function viewerClaimsToExpiry(claims: RemoteDesktopViewerClaims): string {
  return new Date(claims.exp).toISOString();
}

function buildExternalBridgeWsUrl(hostHeader: string, requestProtocol: string): string {
  const protocol = requestProtocol === "https" ? "wss" : "ws";
  const internalAppPort = resolveInternalAppPort();
  const internalBridgePort = resolveInternalBridgePort();
  const delta = internalBridgePort - internalAppPort;
  const normalizedHost = hostHeader.trim().length > 0 ? hostHeader.trim() : `127.0.0.1:${internalAppPort}`;
  const parsed = new URL(`${requestProtocol}://${normalizedHost}`);
  const currentPort = parsed.port.length > 0
    ? Number(parsed.port)
    : requestProtocol === "https"
      ? 443
      : 80;
  parsed.protocol = `${protocol}:`;
  parsed.port = String(currentPort + delta);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function bridgeRuntime(): BridgeRuntimeState {
  const globalState = globalThis as typeof globalThis & {
    __stewardRemoteDesktopBridgeState?: BridgeRuntimeState;
  };
  if (!globalState.__stewardRemoteDesktopBridgeState) {
    globalState.__stewardRemoteDesktopBridgeState = {
      server: null,
      startPromise: null,
      guacdHost: null,
      viewerCounts: new Map<string, number>(),
      port: resolveInternalBridgePort(),
    };
  }
  return globalState.__stewardRemoteDesktopBridgeState;
}

function viewerCountForSession(sessionId: string): number {
  return bridgeRuntime().viewerCounts.get(sessionId) ?? 0;
}

function setViewerCount(sessionId: string, count: number): void {
  const runtime = bridgeRuntime();
  if (count <= 0) {
    runtime.viewerCounts.delete(sessionId);
    return;
  }
  runtime.viewerCounts.set(sessionId, count);
}

function buildRdpConnectionSettings(args: {
  config: RemoteDesktopSessionConfig;
  username?: string;
  password?: string;
  readOnly: boolean;
}): Record<string, unknown> {
  const account = parseRemoteDesktopAccountLabel(args.username);
  return {
    hostname: args.config.host,
    port: String(args.config.port),
    width: args.config.width,
    height: args.config.height,
    dpi: args.config.dpi,
    timezone: stateStore.getSystemSettings().timezone,
    security: "any",
    "ignore-cert": args.config.ignoreCertificateErrors,
    "enable-wallpaper": false,
    "enable-theming": false,
    "enable-font-smoothing": true,
    "enable-desktop-composition": false,
    "resize-method": "display-update",
    "color-depth": String(args.config.colorDepth),
    "read-only": args.readOnly,
    ...(account.username ? { username: account.username } : {}),
    ...(account.domain ? { domain: account.domain } : {}),
    ...(args.password ? { password: args.password } : {}),
  };
}

function buildVncConnectionSettings(args: {
  config: RemoteDesktopSessionConfig;
  username?: string;
  password?: string;
  readOnly: boolean;
}): Record<string, unknown> {
  return {
    hostname: args.config.host,
    port: String(args.config.port),
    width: args.config.width,
    height: args.config.height,
    dpi: args.config.dpi,
    timezone: stateStore.getSystemSettings().timezone,
    "color-depth": String(args.config.colorDepth),
    cursor: true,
    "read-only": args.readOnly,
    ...(args.username ? { username: args.username } : {}),
    ...(args.password ? { password: args.password } : {}),
  };
}

async function buildBridgeToken(args: {
  session: ProtocolSessionRecord;
  lease: ProtocolSessionLease;
  claims: RemoteDesktopViewerClaims;
}): Promise<{ token: string; join: boolean }> {
  const session = args.session;
  const config = readRemoteDesktopSessionConfig(session);
  const credential = config.credentialId
    ? stateStore.getDeviceCredentialById(config.credentialId)
    : undefined;
  const secret = credential ? await vault.getSecret(credential.vaultSecretRef) : undefined;
  const username = config.accountLabel ?? credential?.accountLabel ?? undefined;
  const readOnly = args.claims.mode === "observe" || config.readOnlyDefault;
  const join = typeof config.liveConnectionId === "string"
    && config.liveConnectionId.length > 0
    && viewerCountForSession(session.id) > 0;

  const payload = join
    ? {
      connection: {
        join: config.liveConnectionId,
        settings: {
          width: config.width,
          height: config.height,
          dpi: config.dpi,
          timezone: stateStore.getSystemSettings().timezone,
          "read-only": readOnly,
        },
      },
    }
    : {
      connection: {
        type: session.protocol,
        settings: session.protocol === "rdp"
          ? buildRdpConnectionSettings({ config, username, password: secret, readOnly })
          : buildVncConnectionSettings({ config, username, password: secret, readOnly }),
      },
    };

  const cipherKey = await ensureSecretBuffer(BRIDGE_CIPHER_SECRET_REF, 32);
  return {
    token: encryptGuacamoleToken(payload, cipherKey),
    join,
  };
}

function upsertRemoteDesktopSession(args: OpenSessionArgs): ProtocolSessionRecord {
  const protocol = resolveProtocolForDevice(args.device, args.protocol);
  const credential = selectCredential(args.device.id, protocol, args.credentialId);
  if (args.credentialId && !credential) {
    throw new Error(`Stored ${protocol.toUpperCase()} credential ${args.credentialId} is not available for ${args.device.name}.`);
  }

  const host = typeof args.host === "string" && args.host.trim().length > 0 ? args.host.trim() : args.device.ip;
  const port = clampInt(args.port, 1, 65535, defaultPort(protocol));
  const sessionId = args.sessionId ?? buildSessionId({
    deviceId: args.device.id,
    protocol,
    host,
    port,
    credentialId: credential?.id,
  });
  const existing = stateStore.getProtocolSessionById(sessionId);
  const existingConfig = existing ? readRemoteDesktopSessionConfig(existing) : undefined;

  const nextConfig: RemoteDesktopSessionConfig = {
    host,
    port,
    credentialId: credential?.id,
    accountLabel: credential?.accountLabel ?? existingConfig?.accountLabel,
    width: clampInt(args.width, 640, 4096, existingConfig?.width ?? DEFAULT_WIDTH),
    height: clampInt(args.height, 480, 4096, existingConfig?.height ?? DEFAULT_HEIGHT),
    dpi: clampInt(args.dpi, 72, 300, existingConfig?.dpi ?? DEFAULT_DPI),
    ignoreCertificateErrors: existingConfig?.ignoreCertificateErrors ?? true,
    colorDepth: existingConfig?.colorDepth ?? DEFAULT_COLOR_DEPTH,
    readOnlyDefault: existingConfig?.readOnlyDefault ?? false,
    liveConnectionId: existingConfig?.liveConnectionId,
  };

  const session: ProtocolSessionRecord = {
    id: sessionId,
    deviceId: args.device.id,
    protocol,
    adapterId: protocol,
    desiredState: "active",
    status: existing?.status ?? "idle",
    arbitrationMode: existing?.arbitrationMode ?? "shared",
    singleConnectionHint: existing?.singleConnectionHint ?? false,
    keepaliveAllowed: true,
    summary: existing?.summary ?? remoteDesktopSessionSummary(args.device, protocol, host, port),
    configJson: nextConfig as unknown as Record<string, unknown>,
    activeLeaseId: existing?.activeLeaseId,
    lastConnectedAt: existing?.lastConnectedAt,
    lastDisconnectedAt: existing?.lastDisconnectedAt,
    lastMessageAt: existing?.lastMessageAt,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  return stateStore.upsertProtocolSession(session);
}

function updateSessionOnBridgeOpen(sessionId: string, liveConnectionId?: string): void {
  const session = stateStore.getProtocolSessionById(sessionId);
  if (!session || !REMOTE_DESKTOP_PROTOCOLS.has(session.protocol as RemoteDesktopProtocol)) {
    return;
  }
  const config = readRemoteDesktopSessionConfig(session);
  updateSession(session, {
    status: "connected",
    desiredState: "active",
    lastConnectedAt: nowIso(),
    lastError: undefined,
    configJson: {
      ...config,
      ...(liveConnectionId ? { liveConnectionId } : {}),
    },
  });
}

function updateSessionOnBridgeClose(sessionId: string, error?: unknown): void {
  const session = stateStore.getProtocolSessionById(sessionId);
  if (!session || !REMOTE_DESKTOP_PROTOCOLS.has(session.protocol as RemoteDesktopProtocol)) {
    return;
  }
  const count = viewerCountForSession(sessionId);
  const config = readRemoteDesktopSessionConfig(session);
  updateSession(session, {
    status: count > 0 ? "connected" : "idle",
    lastDisconnectedAt: count > 0 ? session.lastDisconnectedAt : nowIso(),
    lastError: error instanceof Error
      ? error.message
      : typeof error === "string" && error.trim().length > 0
        ? error.trim()
        : count > 0
          ? session.lastError
          : undefined,
    configJson: {
      ...config,
      ...(count > 0 ? {} : { liveConnectionId: undefined }),
    },
  });
}

async function ensureBridgeRuntime(): Promise<void> {
  const runtime = bridgeRuntime();
  if (runtime.server) {
    return;
  }
  if (runtime.startPromise) {
    await runtime.startPromise;
    return;
  }

  runtime.startPromise = (async () => {
    const bridgeHost = await resolveGuacdHost();
    const cipherKey = await ensureSecretBuffer(BRIDGE_CIPHER_SECRET_REF, 32);
    const mod = await import("guacamole-lite");
    const GuacamoleLite = (mod.default ?? mod) as unknown as new (
      wsOptions: Record<string, unknown>,
      guacdOptions: Record<string, unknown>,
      clientOptions: Record<string, unknown>,
      callbacks?: Record<string, unknown>,
    ) => GuacamoleLiteServer;

    const server = new GuacamoleLite(
      {
        host: "0.0.0.0",
        port: runtime.port,
      },
      {
        host: bridgeHost,
        port: GUACD_PORT,
      },
      {
        log: {
          level: "ERRORS",
          stdLog: () => {},
          errorLog: (...args: unknown[]) => {
            console.error("[remote-desktop-bridge]", ...args);
          },
        },
        maxInactivityTime: 0,
        crypt: {
          cypher: "AES-256-CBC",
          key: cipherKey,
        },
      },
    );

    server.on("open", (clientConnection: GuacamoleLiteConnectionEvent) => {
      const sessionId = typeof clientConnection?.query?.sessionId === "string"
        ? clientConnection.query.sessionId.trim()
        : "";
      if (!sessionId) {
        return;
      }
      setViewerCount(sessionId, viewerCountForSession(sessionId) + 1);
      const isJoin = clientConnection?.query?.join === "1";
      updateSessionOnBridgeOpen(
        sessionId,
        !isJoin && typeof clientConnection?.guacamoleConnectionId === "string"
          ? clientConnection.guacamoleConnectionId
          : undefined,
      );
    });

    server.on("close", (clientConnection: GuacamoleLiteConnectionEvent, error?: unknown) => {
      const sessionId = typeof clientConnection?.query?.sessionId === "string"
        ? clientConnection.query.sessionId.trim()
        : "";
      if (!sessionId) {
        return;
      }
      setViewerCount(sessionId, Math.max(0, viewerCountForSession(sessionId) - 1));
      updateSessionOnBridgeClose(sessionId, error);
    });

    runtime.server = server;
    runtime.guacdHost = bridgeHost;
  })();

  try {
    await runtime.startPromise;
  } finally {
    runtime.startPromise = null;
  }
}

function buildClaims(lease: ProtocolSessionLease, holder: string, mode: RemoteDesktopControlMode, ttlMs?: number): RemoteDesktopViewerClaims {
  const effectiveTtlMs = Math.max(10_000, ttlMs ?? DEFAULT_VIEWER_TTL_MS);
  return {
    sessionId: lease.sessionId,
    leaseId: lease.id,
    holder,
    mode,
    exp: Date.now() + effectiveTtlMs,
  };
}

async function issueViewerAccess(session: ProtocolSessionRecord, options: ViewerAccessOptions): Promise<RemoteDesktopViewerAccess> {
  const lease = acquireLease(session, options);
  const claims = buildClaims(lease, options.holder, options.mode ?? "command", options.viewerTtlMs);
  const viewerToken = await issueViewerToken(claims);
  return {
    session: stateStore.getProtocolSessionById(session.id) ?? session,
    lease,
    viewerToken,
    viewerTokenExpiresAt: viewerClaimsToExpiry(claims),
    viewerPath: buildViewerPath(session.id, viewerToken),
  };
}

export const remoteDesktopManager = {
  localStewardOrigin,
  buildAbsoluteUrl,

  listSessions(filter?: { deviceId?: string; protocol?: RemoteDesktopProtocol }) {
    return stateStore.getProtocolSessions({
      ...(filter?.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter?.protocol ? { protocol: filter.protocol } : {}),
    }).filter((session) => REMOTE_DESKTOP_PROTOCOLS.has(session.protocol as RemoteDesktopProtocol));
  },

  getSession(id: string): ProtocolSessionRecord | undefined {
    const session = stateStore.getProtocolSessionById(id) ?? undefined;
    return session && REMOTE_DESKTOP_PROTOCOLS.has(session.protocol as RemoteDesktopProtocol) ? session : undefined;
  },

  async openSession(args: OpenSessionArgs): Promise<RemoteDesktopViewerAccess> {
    const session = upsertRemoteDesktopSession(args);
    await ensureBridgeRuntime();
    return issueViewerAccess(session, args);
  },

  async createViewerAccess(sessionId: string, options: ViewerAccessOptions): Promise<RemoteDesktopViewerAccess> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Remote desktop session ${sessionId} was not found.`);
    }
    await ensureBridgeRuntime();
    return issueViewerAccess(session, options);
  },

  async resolveViewerBootstrap(args: {
    sessionId: string;
    viewerToken: string;
    hostHeader: string;
    requestProtocol: string;
  }): Promise<RemoteDesktopViewerBootstrap> {
    const claims = await verifyViewerToken(args.viewerToken);
    if (claims.sessionId !== args.sessionId) {
      throw new Error("Viewer token does not match the requested session.");
    }

    const session = this.getSession(args.sessionId);
    if (!session) {
      throw new Error(`Remote desktop session ${args.sessionId} was not found.`);
    }

    let lease = stateStore.getProtocolSessionLeaseById(claims.leaseId);
    const leaseMissingOrInactive = !lease || lease.sessionId !== session.id || lease.status !== "active";
    const leaseExpired = lease ? new Date(lease.expiresAt).getTime() <= Date.now() : false;
    if (leaseMissingOrInactive || leaseExpired) {
      try {
        lease = acquireLease(session, {
          holder: claims.holder,
          purpose: `Remote desktop viewer for ${session.summary ?? session.id}`,
          mode: claims.mode,
          exclusive: claims.mode !== "observe",
        });
      } catch {
        if (leaseExpired) {
          throw new Error("Viewer lease has expired.");
        }
        throw new Error("Viewer lease is no longer active.");
      }
    }
    if (!lease) {
      throw new Error("Viewer lease is no longer active.");
    }

    await ensureBridgeRuntime();
    const device = stateStore.getDeviceById(session.deviceId);
    if (!device) {
      throw new Error("Device for this remote desktop session is no longer available.");
    }

    const bridge = await buildBridgeToken({ session, lease, claims });
    const config = readRemoteDesktopSessionConfig(session);
    return {
      session,
      lease,
      claims,
      bridgeWsUrl: buildExternalBridgeWsUrl(args.hostHeader, args.requestProtocol),
      bridgeConnectQuery: new URLSearchParams({
        token: bridge.token,
        sessionId: session.id,
        leaseId: lease.id,
        mode: claims.mode,
        ...(bridge.join ? { join: "1" } : {}),
      }).toString(),
      deviceName: device.name,
      protocol: session.protocol as RemoteDesktopProtocol,
      config,
    };
  },

  buildViewerUrl(sessionId: string, viewerToken: string): string {
    return buildViewerPath(sessionId, viewerToken);
  },

  isRemoteDesktopProtocol(value: unknown): value is RemoteDesktopProtocol {
    return normalizeRemoteDesktopProtocol(value) !== null;
  },
};

export { RemoteDesktopConflictError };



