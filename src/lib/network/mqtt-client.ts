import { randomUUID } from "node:crypto";
import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import type {
  Device,
  MessageSuccessStrategy,
  MqttBrokerRequest,
  MqttMessageQos,
  OperationExecutionPhase,
  OperationExecutionProof,
  OperationExecutionStatus,
} from "@/lib/state/types";
import type { IClientOptions, ISubscriptionGrant, MqttClient } from "mqtt";

const MQTT_SECURE_PORTS = new Set([8883]);
const MQTT_PLAIN_PORTS = new Set([1883]);
const MAX_STRUCTURED_MQTT_PAYLOAD_CHARS = 16_000;

export interface RenderedMqttPublishMessage {
  topic: string;
  payload: string;
  qos: MqttMessageQos;
  retain: boolean;
}

export interface RenderedMqttRequest {
  url: string;
  scheme: "mqtt" | "mqtts";
  host: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  clean: boolean;
  qos: MqttMessageQos;
  retain: boolean;
  subscribeTopics: string[];
  publishMessages: RenderedMqttPublishMessage[];
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  collectMessages: number;
  keepaliveSec: number;
  expectRegex?: string;
  successStrategy: MessageSuccessStrategy;
  insecureSkipVerify: boolean;
  serviceSecure: boolean;
  selfSignedService: boolean;
}

export interface MqttReceivedMessage {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  dup: boolean;
}

export interface MqttExecutionResult {
  ok: boolean;
  status: OperationExecutionStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  summary: string;
  output: string;
  details: Record<string, unknown>;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}

function clampQos(value: number | undefined, fallback: MqttMessageQos): MqttMessageQos {
  if (value === 0 || value === 1 || value === 2) {
    return value;
  }
  return fallback;
}

function truncate(value: string, max = 1_200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 12)).trimEnd()} [truncated]`;
}

function serializeReceivedMessage(message: MqttReceivedMessage): Record<string, unknown> {
  const payload = message.payload.length > MAX_STRUCTURED_MQTT_PAYLOAD_CHARS
    ? message.payload.slice(0, MAX_STRUCTURED_MQTT_PAYLOAD_CHARS)
    : message.payload;
  return {
    topic: message.topic,
    payload,
    payloadBytes: Buffer.byteLength(message.payload, "utf8"),
    payloadTruncated: payload.length !== message.payload.length,
    qos: message.qos,
    retain: message.retain,
    dup: message.dup,
  };
}

function sanitizeClientIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

function matchingMqttService(device: Device, port?: number) {
  return device.services.find((service) =>
    service.transport === "tcp"
      && (port ? service.port === port : (MQTT_SECURE_PORTS.has(service.port) || MQTT_PLAIN_PORTS.has(service.port) || /mqtt/i.test(service.name))),
  );
}

function inferMqttScheme(device: Device, broker: MqttBrokerRequest, port: number): "mqtt" | "mqtts" {
  if (broker.scheme === "mqtt" || broker.scheme === "mqtts") {
    return broker.scheme;
  }

  const service = matchingMqttService(device, port) ?? matchingMqttService(device);
  if (service?.secure || MQTT_SECURE_PORTS.has(port)) {
    return "mqtts";
  }
  return "mqtt";
}

function preferredMqttPort(device: Device, requestedPort: number | undefined, secure?: boolean): number {
  if (requestedPort && Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65_536) {
    return requestedPort;
  }

  const candidates = device.services
    .filter((service) =>
      service.transport === "tcp"
      && (MQTT_SECURE_PORTS.has(service.port) || MQTT_PLAIN_PORTS.has(service.port) || /mqtt/i.test(service.name)),
    )
    .sort((a, b) => {
      if (secure === true) {
        return Number(b.secure) - Number(a.secure) || a.port - b.port;
      }
      if (secure === false) {
        return Number(a.secure) - Number(b.secure) || a.port - b.port;
      }
      return a.port - b.port;
    });

  const matched = candidates[0]?.port;
  if (matched) {
    return matched;
  }
  return secure === false ? 1883 : 8883;
}

function resolveMessageSuccessStrategy(
  requested: MessageSuccessStrategy | undefined,
  hasSubscriptions: boolean,
  hasPublishes: boolean,
  hasExpectation: boolean,
): MessageSuccessStrategy {
  if (requested && requested !== "auto") {
    return requested;
  }
  if (hasExpectation) {
    return "expectation";
  }
  if (hasSubscriptions) {
    return "response";
  }
  if (hasPublishes) {
    return "transport";
  }
  return "transport";
}

function mqttPhaseFromState(args: {
  connected: boolean;
  publishesCompleted: boolean;
  collected: number;
  expectationMatched: boolean;
}): OperationExecutionPhase {
  if (args.expectationMatched) {
    return "verified";
  }
  if (args.collected > 0) {
    return "responded";
  }
  if (args.publishesCompleted) {
    return "sent";
  }
  if (args.connected) {
    return "connected";
  }
  return "not-started";
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

export function renderMqttBrokerRequest(args: {
  device: Device;
  broker: MqttBrokerRequest;
  params?: Record<string, string>;
  credentialUsername?: string;
  password?: string;
}): RenderedMqttRequest {
  const params = args.params ?? {};
  const tentativePort = Number(args.broker.port);
  const safePort = Number.isInteger(tentativePort) && tentativePort > 0 && tentativePort < 65_536
    ? tentativePort
    : undefined;
  const tentativeSecure = safePort
    ? inferMqttScheme(args.device, args.broker, safePort) === "mqtts"
    : args.broker.scheme === "mqtt"
      ? false
      : args.broker.scheme === "mqtts"
        ? true
        : undefined;
  const port = preferredMqttPort(args.device, safePort, tentativeSecure);
  const scheme = inferMqttScheme(args.device, args.broker, port);
  const service = matchingMqttService(args.device, port) ?? matchingMqttService(args.device);
  const serviceSecure = Boolean(service?.secure) || scheme === "mqtts";
  const selfSignedService = Boolean(service?.tlsCert?.selfSigned);
  const requestedUsername = typeof args.broker.username === "string" && args.broker.username.trim().length > 0
    ? interpolateOperationValue(args.broker.username.trim(), args.device.ip, params)
    : undefined;
  const credentialUsername = args.credentialUsername?.trim();
  const username = requestedUsername
    ?? (credentialUsername && credentialUsername.length > 0 ? credentialUsername : undefined)
    ?? undefined;
  const qos = clampQos(args.broker.qos, 0);
  const retain = args.broker.retain ?? false;
  const subscribeTopics = (args.broker.subscribeTopics ?? [])
    .map((topic) => interpolateOperationValue(topic, args.device.ip, params).trim())
    .filter((topic) => topic.length > 0);
  const publishMessages = (args.broker.publishMessages ?? [])
    .map((message) => ({
      topic: interpolateOperationValue(message.topic, args.device.ip, params).trim(),
      payload: typeof message.payload === "string"
        ? interpolateOperationValue(message.payload, args.device.ip, params)
        : "",
      qos: clampQos(message.qos, qos),
      retain: message.retain ?? retain,
    }))
    .filter((message) => message.topic.length > 0);
  const successStrategy = resolveMessageSuccessStrategy(
    args.broker.successStrategy,
    subscribeTopics.length > 0,
    publishMessages.length > 0,
    Boolean(args.broker.expectRegex),
  );
  const collectMessages = clampInt(
    args.broker.collectMessages,
    0,
    50,
    successStrategy === "response" || successStrategy === "expectation"
      ? Math.max(1, subscribeTopics.length)
      : 0,
  );
  const insecureSkipVerify = args.broker.insecureSkipVerify ?? (scheme === "mqtts" && selfSignedService);
  const keepaliveSec = clampInt(args.broker.keepaliveSec, 5, 1_200, 30);
  const connectTimeoutMs = clampInt(args.broker.connectTimeoutMs, 250, 120_000, 5_000);
  const responseTimeoutMs = clampInt(args.broker.responseTimeoutMs, 250, 120_000, 2_000);
  const clientId = sanitizeClientIdPart(args.broker.clientId?.trim() || "")
    || `steward-${sanitizeClientIdPart(args.device.id)}-${randomUUID().slice(0, 8)}`;
  const host = args.device.ip;
  const url = `${scheme}://${host}:${port}`;

  return {
    url,
    scheme,
    host,
    port,
    clientId,
    username,
    password: args.password,
    clean: args.broker.clean ?? true,
    qos,
    retain,
    subscribeTopics,
    publishMessages,
    connectTimeoutMs,
    responseTimeoutMs,
    collectMessages,
    keepaliveSec,
    expectRegex: args.broker.expectRegex,
    successStrategy,
    insecureSkipVerify,
    serviceSecure,
    selfSignedService,
  };
}

export async function executeRenderedMqttRequest(request: RenderedMqttRequest): Promise<MqttExecutionResult> {
  const connect = await loadMqttConnect();

  return new Promise<MqttExecutionResult>((resolve) => {
    let client: MqttClient | null = null;
    let settled = false;
    let connected = false;
    let subscriptionsGranted: ISubscriptionGrant[] = [];
    let publishesCompleted = false;
    let publishedCount = 0;
    let connectError: string | undefined;
    const received: MqttReceivedMessage[] = [];
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let responseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (responseTimer) clearTimeout(responseTimer);
      connectTimer = null;
      responseTimer = null;
    };

    const buildDetails = (extraError?: string, expectationMatched = false): Record<string, unknown> => ({
      url: request.url,
      scheme: request.scheme,
      host: request.host,
      port: request.port,
      clientId: request.clientId,
      username: request.username ?? null,
      clean: request.clean,
      qos: request.qos,
      retain: request.retain,
      subscribeTopics: request.subscribeTopics,
      publishMessages: request.publishMessages.map((message) => ({
        topic: message.topic,
        payloadPreview: truncate(message.payload, 240),
        qos: message.qos,
        retain: message.retain,
      })),
      connectTimeoutMs: request.connectTimeoutMs,
      responseTimeoutMs: request.responseTimeoutMs,
      collectMessages: request.collectMessages,
      keepaliveSec: request.keepaliveSec,
      successStrategy: request.successStrategy,
      insecureSkipVerify: request.insecureSkipVerify,
      selfSignedService: request.selfSignedService,
      connected,
      publishedCount,
      publishesCompleted,
      messagesCollected: received.length,
      messages: received.map((message) => serializeReceivedMessage(message)),
      subscriptionsGranted: subscriptionsGranted.map((grant) => ({
        topic: grant.topic,
        qos: grant.qos,
      })),
      ...(request.expectRegex ? { expectRegex: request.expectRegex, expectationMatched } : {}),
      ...(extraError ? { error: extraError } : {}),
    });

    const buildOutput = (extraError?: string): string => {
      const lines = [
        ...received.map((message) => `[topic] ${message.topic}\n${truncate(message.payload, 2_000)}`),
        extraError ? `[error] ${extraError}` : "",
        `[success strategy: ${request.successStrategy}]`,
        `[subscriptions granted: ${subscriptionsGranted.length}/${request.subscribeTopics.length}]`,
        `[publishes completed: ${publishedCount}/${request.publishMessages.length}]`,
        `[messages collected: ${received.length}]`,
        `[url] ${request.url}`,
      ].filter((value) => value.trim().length > 0);
      return lines.join("\n").trim();
    };

    const evaluateSuccess = (extraError?: string): MqttExecutionResult => {
      const expectationMatched = request.expectRegex
        ? new RegExp(request.expectRegex, "i").test(received.map((message) => message.payload).join("\n\n"))
        : false;
      const output = buildOutput(extraError);
      const phase = mqttPhaseFromState({
        connected,
        publishesCompleted,
        collected: received.length,
        expectationMatched,
      });
      const responseProof: OperationExecutionProof =
        phase === "verified"
          ? "expectation"
          : phase === "responded"
            ? "response"
            : phase === "sent" || phase === "connected"
              ? "transport"
              : "none";

      if (extraError) {
        return {
          ok: false,
          status: "failed",
          phase,
          proof: responseProof,
          summary: "MQTT exchange failed",
          output,
          details: buildDetails(extraError, expectationMatched),
        };
      }

      if (request.successStrategy === "expectation") {
        if (!request.expectRegex) {
          return {
            ok: false,
            status: "failed",
            phase,
            proof: responseProof,
            summary: "MQTT expectation strategy requires expectRegex",
            output,
            details: buildDetails("Missing expectRegex for expectation strategy", expectationMatched),
          };
        }
        if (!expectationMatched) {
          return {
            ok: false,
            status: "inconclusive",
            phase,
            proof: responseProof,
            summary: "MQTT response did not match expectation",
            output: `${output}\n[expectation failed] ${request.expectRegex}`.trim(),
            details: buildDetails(undefined, expectationMatched),
          };
        }
        return {
          ok: true,
          status: "succeeded",
          phase: "verified",
          proof: "expectation",
          summary: "MQTT response matched expectation",
          output,
          details: buildDetails(undefined, expectationMatched),
        };
      }

      if (request.successStrategy === "response") {
        if (received.length > 0) {
          return {
            ok: true,
            status: "succeeded",
            phase: "responded",
            proof: "response",
            summary: "MQTT response received",
            output,
            details: buildDetails(undefined, expectationMatched),
          };
        }
        return {
          ok: false,
          status: "inconclusive",
          phase,
          proof: responseProof,
          summary: "MQTT exchange connected but returned no subscribed message",
          output,
          details: buildDetails(undefined, expectationMatched),
        };
      }

      const transportOk = connected
        && subscriptionsGranted.length === request.subscribeTopics.length
        && publishesCompleted;
      return {
        ok: transportOk,
        status: transportOk ? "succeeded" : "failed",
        phase,
        proof: transportOk ? "transport" : responseProof,
        summary: transportOk
          ? "MQTT transport connected and completed the requested exchange"
          : "MQTT transport did not complete the requested exchange",
        output,
        details: buildDetails(undefined, expectationMatched),
      };
    };

    const finalize = (extraError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      try {
        client?.end(true);
      } catch {
        // Best effort close only.
      }
      resolve(evaluateSuccess(extraError ?? connectError));
    };

    const scheduleFinish = () => {
      if (responseTimer) {
        clearTimeout(responseTimer);
      }
      responseTimer = setTimeout(() => finalize(), request.responseTimeoutMs);
    };

    const publishNext = (index: number) => {
      if (!client) {
        finalize("MQTT client is not available for publish");
        return;
      }

      if (index >= request.publishMessages.length) {
        publishesCompleted = true;
        if (request.successStrategy === "transport" && request.collectMessages === 0) {
          finalize();
          return;
        }
        scheduleFinish();
        return;
      }

      const message = request.publishMessages[index];
      client.publish(
        message.topic,
        message.payload,
        { qos: message.qos, retain: message.retain },
        (error?: Error) => {
          if (error) {
            finalize(error.message);
            return;
          }
          publishedCount += 1;
          publishNext(index + 1);
        },
      );
    };

    try {
      const options: IClientOptions = {
        clientId: request.clientId,
        clean: request.clean,
        reconnectPeriod: 0,
        connectTimeout: request.connectTimeoutMs,
        keepalive: request.keepaliveSec,
        rejectUnauthorized: request.scheme === "mqtts" ? !request.insecureSkipVerify : undefined,
        ...(request.username ? { username: request.username } : {}),
        ...(typeof request.password === "string" ? { password: request.password } : {}),
      };
      client = connect(request.url, options);
    } catch (error) {
      finalize(error instanceof Error ? error.message : String(error));
      return;
    }

    connectTimer = setTimeout(() => {
      finalize("MQTT connect timeout");
    }, request.connectTimeoutMs + 100);

    client.on("connect", () => {
      connected = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      const afterSubscribe = () => {
        if (request.publishMessages.length > 0) {
          publishNext(0);
          return;
        }
        publishesCompleted = true;
        if (request.successStrategy === "transport" && request.collectMessages === 0) {
          finalize();
          return;
        }
        scheduleFinish();
      };

      if (request.subscribeTopics.length === 0) {
        subscriptionsGranted = [];
        afterSubscribe();
        return;
      }

      client?.subscribe(request.subscribeTopics, { qos: request.qos }, (error, granted) => {
        if (error) {
          finalize(error.message);
          return;
        }
        subscriptionsGranted = granted ?? [];
        afterSubscribe();
      });
    });

    client.on("message", (topic, payload, packet) => {
      const normalized: MqttReceivedMessage = {
        topic,
        payload: Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload),
        qos: packet.qos,
        retain: packet.retain,
        dup: packet.dup,
      };
      received.push(normalized);
      if (request.collectMessages > 0 && received.length >= request.collectMessages) {
        finalize();
        return;
      }
      scheduleFinish();
    });

    client.on("error", (error) => {
      connectError = error instanceof Error ? error.message : String(error);
      finalize(connectError);
    });

    client.on("close", () => {
      if (!settled && !connected) {
        finalize(connectError ?? "MQTT connection closed before connect");
      }
    });
  });
}

export async function validateMqttCredentialConnection(args: {
  device: Device;
  credentialUsername?: string;
  password: string;
  broker?: Omit<MqttBrokerRequest, "protocol">;
}): Promise<MqttExecutionResult> {
  const rendered = renderMqttBrokerRequest({
    device: args.device,
    broker: {
      protocol: "mqtt",
      successStrategy: "transport",
      ...(args.broker ?? {}),
    },
    credentialUsername: args.credentialUsername,
    password: args.password,
  });

  return executeRenderedMqttRequest(rendered);
}
