import { createHash, randomUUID } from "node:crypto";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type {
  Device,
  MqttBrokerRequest,
  ProtocolSessionLease,
  ProtocolSessionRecord,
} from "@/lib/state/types";
import {
  renderMqttBrokerRequest,
  type MqttExecutionResult,
  type MqttReceivedMessage,
  type RenderedMqttRequest,
} from "@/lib/network/mqtt-client";
import type { IClientOptions, ISubscriptionGrant, MqttClient } from "mqtt";

interface MqttSessionConfig extends Omit<RenderedMqttRequest, "password"> {
  credentialId?: string;
  deviceId: string;
}

interface ExchangeResult {
  session: ProtocolSessionRecord;
  lease: ProtocolSessionLease;
  result: MqttExecutionResult;
}

interface SessionLeaseRequest {
  sessionId: string;
  holder: string;
  purpose: string;
  mode: ProtocolSessionLease["mode"];
  ttlMs?: number;
  exclusive?: boolean;
  metadataJson?: Record<string, unknown>;
}

interface LiveMqttSession {
  sessionId: string;
  client: MqttClient | null;
  connected: boolean;
  connecting: boolean;
  subscribedTopics: Set<string>;
  reconnectBackoffMs: number;
  connectPromise: Promise<void> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  waiters: Set<MessageWaiter>;
}

interface MessageWaiterResult {
  timedOut: boolean;
  messages: MqttReceivedMessage[];
}

interface MessageWaiter {
  id: string;
  topics: string[];
  collectMessages: number;
  expectRegex?: string;
  messages: MqttReceivedMessage[];
  resolve: (result: MessageWaiterResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class SessionConflictError extends Error {}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSessionId(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) {
    return true;
  }
  const filterParts = filter.split("/");
  const topicParts = topic.split("/");
  for (let index = 0; index < filterParts.length; index += 1) {
    const current = filterParts[index];
    if (current === "#") {
      return true;
    }
    if (current === "+") {
      if (topicParts[index] === undefined) {
        return false;
      }
      continue;
    }
    if (topicParts[index] !== current) {
      return false;
    }
  }
  return filterParts.length === topicParts.length;
}

function truncate(value: string, max = 1_200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 12)).trimEnd()} [truncated]`;
}

async function loadMqttConnect(): Promise<(url: string, options: IClientOptions) => MqttClient> {
  const mod = await import("mqtt");
  const candidate = typeof mod.connect === "function"
    ? mod.connect
    : typeof (mod.default as { connect?: unknown } | undefined)?.connect === "function"
      ? (mod.default as { connect: (url: string, options: IClientOptions) => MqttClient }).connect
      : null;
  if (!candidate) {
    throw new Error("MQTT runtime is unavailable on this Steward host.");
  }
  return candidate as (url: string, options: IClientOptions) => MqttClient;
}

function mqttSuccessStrategy(request: RenderedMqttRequest): "transport" | "response" | "expectation" {
  return request.successStrategy === "expectation"
    ? "expectation"
    : request.successStrategy === "response"
      ? "response"
      : "transport";
}

function buildSessionId(config: MqttSessionConfig): string {
  return `mqtt-${sanitizeSessionId([
    config.deviceId,
    config.host,
    String(config.port),
    config.clientId,
    config.username ?? "",
  ].join("|"))}`;
}

function buildSessionSummary(device: Device, request: RenderedMqttRequest): string {
  return `MQTT ${request.host}:${request.port} for ${device.name}`;
}

function toSessionConfig(
  device: Device,
  rendered: RenderedMqttRequest,
  credentialId?: string,
): MqttSessionConfig {
  const { password: _password, ...withoutPassword } = rendered;
  return {
    ...withoutPassword,
    credentialId,
    deviceId: device.id,
  };
}

function readMqttSessionConfig(session: ProtocolSessionRecord): MqttSessionConfig {
  return session.configJson as unknown as MqttSessionConfig;
}

class ProtocolSessionManager {
  private liveMqtt = new Map<string, LiveMqttSession>();

  listSessions(filter?: {
    deviceId?: string;
    protocol?: ProtocolSessionRecord["protocol"];
    status?: ProtocolSessionRecord["status"];
  }): ProtocolSessionRecord[] {
    return stateStore.getProtocolSessions(filter);
  }

  getSession(id: string): ProtocolSessionRecord | undefined {
    return stateStore.getProtocolSessionById(id);
  }

  getMessages(sessionId: string, limit = 100) {
    return stateStore.getProtocolSessionMessages(sessionId, limit);
  }

  private getLiveMqtt(sessionId: string): LiveMqttSession {
    const existing = this.liveMqtt.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: LiveMqttSession = {
      sessionId,
      client: null,
      connected: false,
      connecting: false,
      subscribedTopics: new Set<string>(),
      reconnectBackoffMs: stateStore.getRuntimeSettings().protocolSessionReconnectBaseMs,
      connectPromise: null,
      reconnectTimer: null,
      waiters: new Set<MessageWaiter>(),
    };
    this.liveMqtt.set(sessionId, created);
    return created;
  }

  private sessionShouldStayConnected(session: ProtocolSessionRecord): boolean {
    const activeLeases = this.getActiveLeases(session.id);
    if (session.desiredState === "stopped") {
      return false;
    }
    if (session.arbitrationMode === "single-connection" || session.singleConnectionHint) {
      return activeLeases.length > 0;
    }
    if (session.keepaliveAllowed && session.desiredState === "active") {
      return true;
    }
    return activeLeases.length > 0;
  }

  private getActiveLeases(sessionId: string): ProtocolSessionLease[] {
    const now = Date.now();
    return stateStore
      .getProtocolSessionLeases({ sessionId, status: "active" })
      .filter((lease) => new Date(lease.expiresAt).getTime() > now);
  }

  private updateSession(session: ProtocolSessionRecord): ProtocolSessionRecord {
    return stateStore.upsertProtocolSession({
      ...session,
      updatedAt: nowIso(),
    });
  }

  private async resolveSessionPassword(config: MqttSessionConfig): Promise<string | undefined> {
    if (!config.credentialId) {
      return undefined;
    }
    const credential = stateStore.getDeviceCredentialById(config.credentialId);
    if (!credential) {
      throw new Error(`Stored MQTT credential ${config.credentialId} is no longer available.`);
    }
    const secret = await vault.getSecret(credential.vaultSecretRef);
    return secret?.trim() ? secret : undefined;
  }

  private async attachMqttHandlers(sessionId: string, live: LiveMqttSession, client: MqttClient): Promise<void> {
    client.on("message", (topic, payload, packet) => {
      const normalized: MqttReceivedMessage = {
        topic,
        payload: Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload),
        qos: packet.qos,
        retain: packet.retain,
        dup: packet.dup,
      };
      const session = stateStore.getProtocolSessionById(sessionId);
      if (!session) {
        return;
      }
      const observedAt = nowIso();
      stateStore.addProtocolSessionMessage({
        id: randomUUID(),
        sessionId,
        deviceId: session.deviceId,
        direction: "inbound",
        channel: normalized.topic,
        payload: normalized.payload,
        metadataJson: {
          qos: normalized.qos,
          retain: normalized.retain,
          dup: normalized.dup,
        },
        observedAt,
      });
      stateStore.upsertProtocolSession({
        ...session,
        lastMessageAt: observedAt,
        status: "connected",
        lastError: undefined,
        updatedAt: observedAt,
      });

      for (const waiter of Array.from(live.waiters)) {
        if (!waiter.topics.some((filter) => topicMatches(filter, normalized.topic))) {
          continue;
        }
        waiter.messages.push(normalized);
        const expectationMatched = waiter.expectRegex
          ? new RegExp(waiter.expectRegex, "i").test(waiter.messages.map((item) => item.payload).join("\n\n"))
          : false;
        if (
          expectationMatched
          || (waiter.collectMessages > 0 && waiter.messages.length >= waiter.collectMessages)
        ) {
          clearTimeout(waiter.timeout);
          live.waiters.delete(waiter);
          waiter.resolve({ timedOut: false, messages: waiter.messages });
        }
      }
    });

    client.on("error", (error) => {
      const session = stateStore.getProtocolSessionById(sessionId);
      live.connected = false;
      live.connecting = false;
      if (session) {
        stateStore.upsertProtocolSession({
          ...session,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: nowIso(),
        });
        this.scheduleReconnect(sessionId);
      }
    });

    client.on("close", () => {
      const session = stateStore.getProtocolSessionById(sessionId);
      live.connected = false;
      live.connecting = false;
      live.subscribedTopics.clear();
      if (session) {
        stateStore.upsertProtocolSession({
          ...session,
          status: this.sessionShouldStayConnected(session) ? "error" : "idle",
          lastDisconnectedAt: nowIso(),
          updatedAt: nowIso(),
        });
        this.scheduleReconnect(sessionId);
      }
    });
  }

  private scheduleReconnect(sessionId: string): void {
    const session = stateStore.getProtocolSessionById(sessionId);
    if (!session || !this.sessionShouldStayConnected(session)) {
      return;
    }
    const live = this.getLiveMqtt(sessionId);
    if (live.reconnectTimer || live.connecting || live.connected) {
      return;
    }
    const runtime = stateStore.getRuntimeSettings();
    const delay = Math.min(live.reconnectBackoffMs, runtime.protocolSessionReconnectMaxMs);
    live.reconnectTimer = setTimeout(() => {
      live.reconnectTimer = null;
      void this.ensureMqttConnection(sessionId).catch(() => {
        // Retry scheduling is handled by the close/error paths.
      });
    }, delay);
    live.reconnectBackoffMs = Math.min(delay * 2, runtime.protocolSessionReconnectMaxMs);
  }

  private async ensureMqttConnection(sessionId: string): Promise<void> {
    const session = stateStore.getProtocolSessionById(sessionId);
    if (!session) {
      throw new Error(`Protocol session ${sessionId} not found.`);
    }
    const config = readMqttSessionConfig(session);
    const live = this.getLiveMqtt(sessionId);
    if (live.connected) {
      return;
    }
    if (live.connectPromise) {
      await live.connectPromise;
      return;
    }

    live.connecting = true;
    live.connectPromise = (async () => {
      const connect = await loadMqttConnect();
      const password = await this.resolveSessionPassword(config);
      const options: IClientOptions = {
        clientId: config.clientId,
        clean: config.clean,
        reconnectPeriod: 0,
        connectTimeout: config.connectTimeoutMs,
        keepalive: config.keepaliveSec,
        rejectUnauthorized: config.scheme === "mqtts" ? !config.insecureSkipVerify : undefined,
        ...(config.username ? { username: config.username } : {}),
        ...(typeof password === "string" ? { password } : {}),
      };

      await new Promise<void>((resolve, reject) => {
        let client: MqttClient;
        try {
          client = connect(config.url, options);
        } catch (error) {
          reject(error);
          return;
        }

        live.client = client;
        const timeout = setTimeout(() => {
          try {
            client.end(true);
          } catch {
            // Best-effort close only.
          }
          reject(new Error("MQTT connect timeout"));
        }, config.connectTimeoutMs + 100);

        client.once("connect", () => {
          clearTimeout(timeout);
          live.connected = true;
          live.connecting = false;
          live.reconnectBackoffMs = stateStore.getRuntimeSettings().protocolSessionReconnectBaseMs;
          void this.attachMqttHandlers(sessionId, live, client);
          const current = stateStore.getProtocolSessionById(sessionId);
          if (current) {
            stateStore.upsertProtocolSession({
              ...current,
              status: "connected",
              lastConnectedAt: nowIso(),
              lastError: undefined,
              updatedAt: nowIso(),
            });
          }
          resolve();
        });

        client.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      await this.ensureSubscribed(sessionId, config.subscribeTopics ?? []);
    })();

    try {
      await live.connectPromise;
    } finally {
      live.connectPromise = null;
      live.connecting = false;
    }
  }

  private async ensureSubscribed(sessionId: string, topics: string[]): Promise<ISubscriptionGrant[]> {
    const live = this.getLiveMqtt(sessionId);
    if (!live.client || topics.length === 0) {
      return [];
    }
    const needed = topics.filter((topic) => !live.subscribedTopics.has(topic));
    if (needed.length === 0) {
      return [];
    }
    const session = stateStore.getProtocolSessionById(sessionId);
    if (!session) {
      return [];
    }

    return new Promise<ISubscriptionGrant[]>((resolve, reject) => {
      live.client?.subscribe(needed, { qos: readMqttSessionConfig(session).qos }, (error, granted) => {
        if (error) {
          reject(error);
          return;
        }
        for (const topic of needed) {
          live.subscribedTopics.add(topic);
        }
        resolve(granted ?? []);
      });
    });
  }

  private async disconnectMqttSession(sessionId: string, reason = "disconnected"): Promise<void> {
    const live = this.liveMqtt.get(sessionId);
    if (!live) {
      return;
    }
    if (live.reconnectTimer) {
      clearTimeout(live.reconnectTimer);
      live.reconnectTimer = null;
    }
    for (const waiter of Array.from(live.waiters)) {
      clearTimeout(waiter.timeout);
      live.waiters.delete(waiter);
      waiter.resolve({ timedOut: true, messages: waiter.messages });
    }
    try {
      live.client?.end(true);
    } catch {
      // Best-effort close only.
    }
    this.liveMqtt.delete(sessionId);
    const session = stateStore.getProtocolSessionById(sessionId);
    if (session) {
      stateStore.upsertProtocolSession({
        ...session,
        status: session.desiredState === "stopped" ? "stopped" : "idle",
        lastDisconnectedAt: nowIso(),
        lastError: reason,
        updatedAt: nowIso(),
      });
    }
  }

  private upsertMqttSession(args: {
    device: Device;
    rendered: RenderedMqttRequest;
    credentialId?: string;
    sessionId?: string;
    adapterId?: string;
    desiredState?: ProtocolSessionRecord["desiredState"];
    arbitrationMode?: ProtocolSessionRecord["arbitrationMode"];
    keepaliveAllowed?: boolean;
    singleConnectionHint?: boolean;
    summary?: string;
  }): ProtocolSessionRecord {
    const config = toSessionConfig(args.device, args.rendered, args.credentialId);
    const sessionId = args.sessionId ?? buildSessionId(config);
    const existing = stateStore.getProtocolSessionById(sessionId);
    const subscribeTopics = Array.from(new Set([
      ...((existing?.configJson as Partial<MqttSessionConfig> | undefined)?.subscribeTopics ?? []),
      ...(config.subscribeTopics ?? []),
    ]));

    const session: ProtocolSessionRecord = {
      id: sessionId,
      deviceId: args.device.id,
      protocol: "mqtt",
      adapterId: args.adapterId ?? existing?.adapterId,
      desiredState: args.desiredState ?? existing?.desiredState ?? "idle",
      status: existing?.status ?? "idle",
      arbitrationMode: args.arbitrationMode ?? existing?.arbitrationMode ?? "shared",
      singleConnectionHint: args.singleConnectionHint ?? existing?.singleConnectionHint ?? false,
      keepaliveAllowed: args.keepaliveAllowed ?? existing?.keepaliveAllowed ?? false,
      summary: args.summary ?? existing?.summary ?? buildSessionSummary(args.device, args.rendered),
      configJson: {
        ...(existing?.configJson ?? {}),
        ...config,
        subscribeTopics,
      },
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

  private acquireLease(request: SessionLeaseRequest): ProtocolSessionLease {
    const session = stateStore.getProtocolSessionById(request.sessionId);
    if (!session) {
      throw new Error(`Protocol session ${request.sessionId} not found.`);
    }

    this.expireStaleLeases();
    const current = this.getActiveLeases(request.sessionId);
    const conflicting = current.find((lease) =>
      lease.holder !== request.holder
      && (
        session.arbitrationMode !== "shared"
        || request.exclusive === true
        || lease.exclusive
      )
    );
    if (conflicting) {
      throw new SessionConflictError(
        `${session.summary ?? session.id} is already leased by ${conflicting.holder}.`,
      );
    }

    const now = Date.now();
    const runtime = stateStore.getRuntimeSettings();
    const ttlMs = Math.min(
      Math.max(10_000, request.ttlMs ?? runtime.protocolSessionDefaultLeaseTtlMs),
      runtime.protocolSessionMaxLeaseTtlMs,
    );
    const existing = current.find((lease) => lease.holder === request.holder && lease.mode === request.mode);
    const lease: ProtocolSessionLease = {
      id: existing?.id ?? randomUUID(),
      sessionId: request.sessionId,
      holder: request.holder,
      purpose: request.purpose,
      mode: request.mode,
      status: "active",
      exclusive: request.exclusive ?? session.arbitrationMode !== "shared",
      requestedAt: existing?.requestedAt ?? nowIso(),
      grantedAt: nowIso(),
      releasedAt: undefined,
      expiresAt: new Date(now + ttlMs).toISOString(),
      metadataJson: request.metadataJson ?? existing?.metadataJson ?? {},
    };
    stateStore.upsertProtocolSessionLease(lease);
    stateStore.upsertProtocolSession({
      ...session,
      activeLeaseId: lease.id,
      status: session.status === "stopped" ? "idle" : session.status,
      updatedAt: nowIso(),
    });
    return lease;
  }

  releaseLease(id: string): ProtocolSessionLease | undefined {
    const lease = stateStore.getProtocolSessionLeaseById(id);
    if (!lease || lease.status !== "active") {
      return undefined;
    }
    const released: ProtocolSessionLease = {
      ...lease,
      status: "released",
      releasedAt: nowIso(),
    };
    stateStore.upsertProtocolSessionLease(released);
    const session = stateStore.getProtocolSessionById(lease.sessionId);
    if (session) {
      const nextActive = this.getActiveLeases(session.id).filter((entry) => entry.id !== lease.id);
      stateStore.upsertProtocolSession({
        ...session,
        activeLeaseId: nextActive[0]?.id,
        updatedAt: nowIso(),
      });
      if (!this.sessionShouldStayConnected(session)) {
        void this.disconnectMqttSession(session.id, "lease released");
      }
    }
    return released;
  }

  expireStaleLeases(): number {
    const now = Date.now();
    let expired = 0;
    for (const lease of stateStore.getProtocolSessionLeases({ status: "active" })) {
      if (new Date(lease.expiresAt).getTime() > now) {
        continue;
      }
      stateStore.upsertProtocolSessionLease({
        ...lease,
        status: "expired",
        releasedAt: nowIso(),
      });
      const session = stateStore.getProtocolSessionById(lease.sessionId);
      if (session?.activeLeaseId === lease.id) {
        stateStore.upsertProtocolSession({
          ...session,
          activeLeaseId: undefined,
          updatedAt: nowIso(),
        });
      }
      expired += 1;
    }
    return expired;
  }

  private async waitForMessages(
    sessionId: string,
    topics: string[],
    collectMessages: number,
    responseTimeoutMs: number,
    expectRegex?: string,
  ): Promise<MessageWaiterResult> {
    const live = this.getLiveMqtt(sessionId);
    return new Promise<MessageWaiterResult>((resolve) => {
      const waiter: MessageWaiter = {
        id: randomUUID(),
        topics,
        collectMessages,
        expectRegex,
        messages: [],
        resolve,
        timeout: setTimeout(() => {
          live.waiters.delete(waiter);
          resolve({ timedOut: true, messages: waiter.messages });
        }, responseTimeoutMs),
      };
      live.waiters.add(waiter);
    });
  }

  private buildExchangeResult(args: {
    session: ProtocolSessionRecord;
    request: RenderedMqttRequest;
    lease: ProtocolSessionLease;
    subscriptionsGranted: ISubscriptionGrant[];
    messages: MqttReceivedMessage[];
    publishedCount: number;
    timedOut: boolean;
    error?: string;
  }): MqttExecutionResult {
    const expectationMatched = args.request.expectRegex
      ? new RegExp(args.request.expectRegex, "i").test(args.messages.map((message) => message.payload).join("\n\n"))
      : false;
    const successStrategy = mqttSuccessStrategy(args.request);
    const outputLines = [
      ...args.messages.map((message) => `[topic] ${message.topic}\n${truncate(message.payload, 2_000)}`),
      args.error ? `[error] ${args.error}` : "",
      args.timedOut ? "[timeout] response window elapsed" : "",
      `[session] ${args.session.id}`,
      `[lease] ${args.lease.id}`,
      `[messages collected: ${args.messages.length}]`,
      `[publishes completed: ${args.publishedCount}/${args.request.publishMessages.length}]`,
      `[subscriptions granted: ${args.subscriptionsGranted.length}/${args.request.subscribeTopics.length}]`,
      `[url] ${args.request.url}`,
    ].filter((value) => value.trim().length > 0);
    const output = outputLines.join("\n").trim();

    if (args.error) {
      return {
        ok: false,
        status: "failed",
        phase: args.messages.length > 0 ? "responded" : "connected",
        proof: args.messages.length > 0 ? "response" : "transport",
        summary: "MQTT session exchange failed",
        output,
        details: {
          sessionId: args.session.id,
          leaseId: args.lease.id,
          error: args.error,
          messages: args.messages,
        },
      };
    }

    if (successStrategy === "expectation") {
      return expectationMatched
        ? {
          ok: true,
          status: "succeeded",
          phase: "verified",
          proof: "expectation",
          summary: "MQTT session response matched expectation",
          output,
          details: {
            sessionId: args.session.id,
            leaseId: args.lease.id,
            expectationMatched,
            messages: args.messages,
          },
        }
        : {
          ok: false,
          status: "inconclusive",
          phase: args.messages.length > 0 ? "responded" : "connected",
          proof: args.messages.length > 0 ? "response" : "transport",
          summary: "MQTT session response did not match expectation",
          output,
          details: {
            sessionId: args.session.id,
            leaseId: args.lease.id,
            expectationMatched,
            messages: args.messages,
          },
        };
    }

    if (successStrategy === "response") {
      return args.messages.length > 0
        ? {
          ok: true,
          status: "succeeded",
          phase: "responded",
          proof: "response",
          summary: "MQTT session response received",
          output,
          details: {
            sessionId: args.session.id,
            leaseId: args.lease.id,
            messages: args.messages,
          },
        }
        : {
          ok: false,
          status: "inconclusive",
          phase: "connected",
          proof: "transport",
          summary: "MQTT session returned no subscribed response",
          output,
          details: {
            sessionId: args.session.id,
            leaseId: args.lease.id,
            messages: args.messages,
          },
        };
    }

    return {
      ok: true,
      status: "succeeded",
      phase: args.messages.length > 0 ? "responded" : "sent",
      proof: args.messages.length > 0 ? "response" : "transport",
      summary: "MQTT session transport completed the requested exchange",
      output,
      details: {
        sessionId: args.session.id,
        leaseId: args.lease.id,
        messages: args.messages,
      },
    };
  }

  async exchangeMqtt(args: {
    device: Device;
    rendered: RenderedMqttRequest;
    credentialId?: string;
    sessionId?: string;
    adapterId?: string;
    holder: string;
    purpose: string;
    keepSessionOpen?: boolean;
    desiredState?: ProtocolSessionRecord["desiredState"];
    arbitrationMode?: ProtocolSessionRecord["arbitrationMode"];
    singleConnectionHint?: boolean;
    leaseTtlMs?: number;
  }): Promise<ExchangeResult> {
    const session = this.upsertMqttSession({
      device: args.device,
      rendered: args.rendered,
      credentialId: args.credentialId,
      sessionId: args.sessionId,
      adapterId: args.adapterId,
      keepaliveAllowed: args.keepSessionOpen === true,
      desiredState: args.keepSessionOpen ? (args.desiredState ?? "active") : (args.desiredState ?? "idle"),
      arbitrationMode: args.arbitrationMode,
      singleConnectionHint: args.singleConnectionHint,
    });

    let lease: ProtocolSessionLease;
    try {
      lease = this.acquireLease({
        sessionId: session.id,
        holder: args.holder,
        purpose: args.purpose,
        mode: args.rendered.publishMessages.length > 0 ? "command" : "exchange",
        ttlMs: args.leaseTtlMs,
        exclusive: session.arbitrationMode !== "shared" || session.singleConnectionHint,
        metadataJson: {
          keepSessionOpen: args.keepSessionOpen === true,
        },
      });
    } catch (error) {
      if (error instanceof SessionConflictError) {
        return {
          session,
          lease: {
            id: "conflict",
            sessionId: session.id,
            holder: args.holder,
            purpose: args.purpose,
            mode: args.rendered.publishMessages.length > 0 ? "command" : "exchange",
            status: "rejected",
            exclusive: true,
            requestedAt: nowIso(),
            expiresAt: nowIso(),
            metadataJson: {},
          },
          result: {
            ok: false,
            status: "blocked",
            phase: "blocked",
            proof: "none",
            summary: error.message,
            output: error.message,
            details: {
              sessionId: session.id,
            },
          },
        };
      }
      throw error;
    }

    let subscriptionsGranted: ISubscriptionGrant[] = [];
    let publishedCount = 0;
    try {
      await this.ensureMqttConnection(session.id);
      subscriptionsGranted = await this.ensureSubscribed(session.id, args.rendered.subscribeTopics);
      const live = this.getLiveMqtt(session.id);

      const waitPromise = (
        args.rendered.collectMessages > 0
        || args.rendered.successStrategy === "response"
        || args.rendered.successStrategy === "expectation"
        || Boolean(args.rendered.expectRegex)
      )
        ? this.waitForMessages(
          session.id,
          args.rendered.subscribeTopics.length > 0 ? args.rendered.subscribeTopics : ["#"],
          Math.max(1, args.rendered.collectMessages || 1),
          args.rendered.responseTimeoutMs,
          args.rendered.expectRegex,
        )
        : Promise.resolve({ timedOut: false, messages: [] as MqttReceivedMessage[] });

      for (const message of args.rendered.publishMessages) {
        stateStore.addProtocolSessionMessage({
          id: randomUUID(),
          sessionId: session.id,
          deviceId: session.deviceId,
          direction: "outbound",
          channel: message.topic,
          payload: message.payload,
          metadataJson: {
            qos: message.qos,
            retain: message.retain,
          },
          observedAt: nowIso(),
        });
        await new Promise<void>((resolve, reject) => {
          live.client?.publish(
            message.topic,
            message.payload,
            { qos: message.qos, retain: message.retain },
            (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            },
          );
        });
        publishedCount += 1;
      }

      const waited = await waitPromise;
      const result = this.buildExchangeResult({
        session: stateStore.getProtocolSessionById(session.id) ?? session,
        request: args.rendered,
        lease,
        subscriptionsGranted,
        messages: waited.messages,
        publishedCount,
        timedOut: waited.timedOut,
      });

      if (!args.keepSessionOpen) {
        this.releaseLease(lease.id);
      }

      return {
        session: stateStore.getProtocolSessionById(session.id) ?? session,
        lease,
        result,
      };
    } catch (error) {
      const result = this.buildExchangeResult({
        session: stateStore.getProtocolSessionById(session.id) ?? session,
        request: args.rendered,
        lease,
        subscriptionsGranted,
        messages: [],
        publishedCount,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!args.keepSessionOpen) {
        this.releaseLease(lease.id);
      }
      return {
        session: stateStore.getProtocolSessionById(session.id) ?? session,
        lease,
        result,
      };
    }
  }

  async openPersistentMqttSession(args: {
    device: Device;
    broker: MqttBrokerRequest;
    credentialId?: string;
    credentialUsername?: string;
    holder: string;
    purpose: string;
    sessionId?: string;
    adapterId?: string;
    arbitrationMode?: ProtocolSessionRecord["arbitrationMode"];
    singleConnectionHint?: boolean;
  }): Promise<ProtocolSessionRecord> {
    const rendered = renderMqttBrokerRequest({
      device: args.device,
      broker: {
        ...args.broker,
        successStrategy: "transport",
        collectMessages: 0,
      },
      credentialUsername: args.credentialUsername,
      password: undefined,
    });
    const outcome = await this.exchangeMqtt({
      device: args.device,
      rendered,
      credentialId: args.credentialId,
      sessionId: args.sessionId,
      adapterId: args.adapterId,
      holder: args.holder,
      purpose: args.purpose,
      keepSessionOpen: true,
      desiredState: "active",
      arbitrationMode: args.arbitrationMode,
      singleConnectionHint: args.singleConnectionHint,
    });
    if (!outcome.result.ok) {
      throw new Error(outcome.result.summary);
    }
    return outcome.session;
  }

  async sweep(): Promise<void> {
    this.expireStaleLeases();
    const runtime = stateStore.getRuntimeSettings();
    for (const session of stateStore.getProtocolSessions()) {
      const activeLeases = this.getActiveLeases(session.id);
      const activeLeaseId = activeLeases[0]?.id;
      const current = activeLeaseId !== session.activeLeaseId
        ? stateStore.upsertProtocolSession({
          ...session,
          activeLeaseId,
          updatedAt: nowIso(),
        })
        : session;
      if (current.protocol !== "mqtt") {
        continue;
      }
      if (this.sessionShouldStayConnected(current)) {
        try {
          await this.ensureMqttConnection(current.id);
          await this.ensureSubscribed(current.id, (readMqttSessionConfig(current).subscribeTopics ?? []));
        } catch {
          // Session state is already updated in the connection path.
        }
      } else {
        await this.disconnectMqttSession(current.id, "session idle");
      }
      stateStore.pruneProtocolSessionMessages(current.id, runtime.protocolSessionMessageRetentionLimit);
    }
  }
}

export const protocolSessionManager = new ProtocolSessionManager();
