import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  computeDeviceStateHash,
  executeOperationWithGates,
} from "@/lib/adapters/execution-kernel";
import { evaluatePolicy } from "@/lib/policy/engine";
import { stateStore } from "@/lib/state/store";
import type {
  ActionClass,
  Device,
  DeviceWidget,
  DeviceWidgetOperationRun,
  OperationKind,
  OperationMode,
  OperationSpec,
  ProtocolBrokerRequest,
  WidgetOperationResult,
} from "@/lib/state/types";

const ValueSchema = z.union([z.string(), z.number(), z.boolean()]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBooleanAlias(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function readPortAlias(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function normalizeHttpMethod(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toUpperCase() : value;
}

function normalizeHttpScheme(value: unknown): unknown {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function normalizeHttpBrokerInput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const insecureSkipVerify = readBooleanAlias(value.insecureSkipVerify)
    ?? readBooleanAlias(value.insecure_skip_verify)
    ?? readBooleanAlias(value.skipCertChecks)
    ?? readBooleanAlias(value.skip_cert_checks);

  return {
    ...value,
    method: normalizeHttpMethod(value.method),
    scheme: normalizeHttpScheme(value.scheme),
    schemes: Array.isArray(value.schemes) ? value.schemes.map((entry) => normalizeHttpScheme(entry)) : value.schemes,
    port: readPortAlias(value.port) ?? value.port,
    ...(typeof insecureSkipVerify === "boolean" ? { insecureSkipVerify } : {}),
  };
}

const HttpBrokerSchema = z.object({
  protocol: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  scheme: z.enum(["http", "https"]).optional(),
  schemes: z.array(z.enum(["http", "https"])).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().min(1),
  query: z.record(z.string(), ValueSchema).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  insecureSkipVerify: z.boolean().optional(),
  expectRegex: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  sessionHolder: z.string().min(1).optional(),
});

const SshBrokerSchema = z.object({
  protocol: z.literal("ssh"),
  argv: z.array(z.string()).min(1),
  port: z.number().int().min(1).max(65535).optional(),
});

const TelnetBrokerSchema = z.object({
  protocol: z.literal("telnet"),
  command: z.string().min(1),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  expectRegex: z.string().optional(),
});

const WinrmBrokerSchema = z.object({
  protocol: z.literal("winrm"),
  command: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  skipCertChecks: z.boolean().optional(),
  authentication: z.string().min(1).optional(),
  expectRegex: z.string().optional(),
});

const PowerShellSshBrokerSchema = z.object({
  protocol: z.literal("powershell-ssh"),
  command: z.string().min(1),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  expectRegex: z.string().optional(),
});

const WmiBrokerSchema = z.object({
  protocol: z.literal("wmi"),
  command: z.string().min(1),
  host: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  expectRegex: z.string().optional(),
});

const SmbBrokerSchema = z.object({
  protocol: z.literal("smb"),
  command: z.string().min(1),
  host: z.string().min(1).optional(),
  share: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  expectRegex: z.string().optional(),
});

const RdpBrokerSchema = z.object({
  protocol: z.literal("rdp"),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  action: z.enum(["check", "launch"]).optional(),
  admin: z.boolean().optional(),
});

const WebSocketBrokerSchema = z.object({
  protocol: z.literal("websocket"),
  scheme: z.enum(["ws", "wss"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  path: z.string().min(1),
  query: z.record(z.string(), ValueSchema).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  protocols: z.array(z.string()).optional(),
  messages: z.array(z.string()).optional(),
  sendOn: z.enum(["open", "first-message"]).optional(),
  connectTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  responseTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  collectMessages: z.number().int().min(1).max(50).optional(),
  expectRegex: z.string().optional(),
  successStrategy: z.enum(["auto", "transport", "response", "expectation"]).optional(),
  sessionId: z.string().min(1).optional(),
  sessionHolder: z.string().min(1).optional(),
});

const MqttBrokerSchema = z.object({
  protocol: z.literal("mqtt"),
  scheme: z.enum(["mqtt", "mqtts"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  clientId: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  clean: z.boolean().optional(),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  retain: z.boolean().optional(),
  subscribeTopics: z.array(z.string().min(1)).optional(),
  publishMessages: z.array(z.object({
    topic: z.string().min(1),
    payload: z.string().optional(),
    qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    retain: z.boolean().optional(),
  })).optional(),
  connectTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  responseTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  collectMessages: z.number().int().min(0).max(50).optional(),
  keepaliveSec: z.number().int().min(5).max(1_200).optional(),
  expectRegex: z.string().optional(),
  successStrategy: z.enum(["auto", "transport", "response", "expectation"]).optional(),
  insecureSkipVerify: z.boolean().optional(),
});

function normalizeWidgetOperationInput(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.brokerRequest) || value.brokerRequest.protocol !== "http") {
    return value;
  }

  return {
    ...value,
    brokerRequest: normalizeHttpBrokerInput(value.brokerRequest),
  };
}

export const WidgetOperationSchema = z.preprocess(normalizeWidgetOperationInput, z.object({
  mode: z.enum(["read", "mutate"]).default("read"),
  kind: z.enum([
    "shell.command",
    "service.restart",
    "service.stop",
    "container.restart",
    "container.stop",
    "http.request",
    "websocket.message",
    "mqtt.message",
    "cert.renew",
    "file.copy",
    "network.config",
  ]),
  adapterId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(500).max(180_000).optional(),
  commandTemplate: z.string().max(8_000).optional(),
  brokerRequest: z.discriminatedUnion("protocol", [
    HttpBrokerSchema,
    SshBrokerSchema,
    TelnetBrokerSchema,
    WebSocketBrokerSchema,
    MqttBrokerSchema,
    WinrmBrokerSchema,
    PowerShellSshBrokerSchema,
    WmiBrokerSchema,
    SmbBrokerSchema,
    RdpBrokerSchema,
  ]).optional(),
  args: z.record(z.string(), ValueSchema).optional(),
  expectedSemanticTarget: z.string().max(240).optional(),
}).refine((value) => Boolean(value.commandTemplate) || Boolean(value.brokerRequest), {
  message: "commandTemplate or brokerRequest is required",
}));

export type WidgetOperationInput = z.infer<typeof WidgetOperationSchema>;

function stringifyParamValue(value: string | number | boolean | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function extractSerialFromSubject(subject: string | undefined): string | undefined {
  if (!subject) {
    return undefined;
  }
  const cnMatch = subject.match(/(?:^|[,/])\s*(?:CN|commonName)\s*=\s*([^,/]+)/i);
  const candidate = (cnMatch?.[1] ?? subject).trim();
  if (/^[A-Za-z0-9._-]{5,}$/.test(candidate)) {
    return candidate;
  }
  return undefined;
}

function inferDeviceSerial(device: Device): string | undefined {
  const metadataSources = [
    device.metadata,
    isRecord(device.metadata.notes) ? device.metadata.notes : null,
    isRecord(device.metadata.notes) && isRecord(device.metadata.notes.structuredContext)
      ? device.metadata.notes.structuredContext
      : null,
    isRecord(device.metadata.fingerprint) ? device.metadata.fingerprint : null,
  ].filter((value): value is Record<string, unknown> => isRecord(value));

  for (const source of metadataSources) {
    for (const key of ["serial", "serialNumber", "serial_number", "deviceSerial", "device_serial"]) {
      const candidate = stringifyParamValue(
        typeof source[key] === "string" || typeof source[key] === "number" || typeof source[key] === "boolean"
          ? source[key] as string | number | boolean
          : undefined,
      );
      if (candidate) {
        return candidate;
      }
    }
  }

  for (const service of device.services) {
    const candidate = extractSerialFromSubject(service.tlsCert?.subject);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function buildWidgetExecutionParams(device: Device, input: WidgetOperationInput): Record<string, string> {
  const params: Record<string, string> = {
    host: device.ip,
    ip: device.ip,
    device_id: device.id,
    deviceId: device.id,
    name: device.name,
    type: device.type,
    status: device.status,
  };

  const serial = inferDeviceSerial(device);
  if (serial) {
    params.serial = serial;
  }

  const optionalFields: Array<[string, string | undefined]> = [
    ["hostname", device.hostname],
    ["mac", device.mac],
    ["vendor", device.vendor],
    ["os", device.os],
    ["role", device.role],
    [
      "product",
      isRecord(device.metadata.fingerprint) && typeof device.metadata.fingerprint.inferredProduct === "string"
        ? device.metadata.fingerprint.inferredProduct
        : undefined,
    ],
  ];

  for (const [key, rawValue] of optionalFields) {
    const value = stringifyParamValue(rawValue);
    if (value) {
      params[key] = value;
    }
  }

  for (const [key, rawValue] of Object.entries(input.args ?? {})) {
    const value = stringifyParamValue(rawValue);
    if (value) {
      params[key] = value;
    }
  }

  return params;
}

function inferAdapterId(input: WidgetOperationInput): string {
  if (input.adapterId) {
    return input.adapterId;
  }
  if (input.brokerRequest?.protocol === "ssh") {
    return "ssh";
  }
  if (input.brokerRequest?.protocol === "telnet") {
    return "telnet";
  }
  if (input.brokerRequest?.protocol === "winrm") {
    return "winrm";
  }
  if (input.brokerRequest?.protocol === "powershell-ssh") {
    return "powershell-ssh";
  }
  if (input.brokerRequest?.protocol === "wmi") {
    return "wmi";
  }
  if (input.brokerRequest?.protocol === "smb") {
    return "smb";
  }
  if (input.brokerRequest?.protocol === "rdp") {
    return "rdp";
  }
  if (input.brokerRequest?.protocol === "mqtt") {
    return "mqtt";
  }
  if (input.brokerRequest?.protocol === "http" || input.brokerRequest?.protocol === "websocket") {
    return "http-api";
  }
  if (input.kind === "mqtt.message") {
    return "mqtt";
  }
  return input.kind === "http.request" || input.kind === "websocket.message" ? "http-api" : "ssh";
}

function criticalityForOperation(kind: OperationKind, mode: OperationMode): "low" | "medium" | "high" {
  if (mode === "read") {
    return "low";
  }
  if (kind === "network.config") {
    return "high";
  }
  if (kind === "file.copy" || kind === "cert.renew" || kind === "shell.command") {
    return "medium";
  }
  return "low";
}

function actionClassForOperation(kind: OperationKind, mode: OperationMode): ActionClass {
  if (mode === "read") {
    return "A";
  }
  if (
    kind === "service.restart"
    || kind === "service.stop"
    || kind === "container.restart"
    || kind === "container.stop"
    || kind === "http.request"
    || kind === "websocket.message"
    || kind === "mqtt.message"
  ) {
    return "B";
  }
  if (kind === "network.config") {
    return "D";
  }
  return "C";
}

function buildOperationSpec(device: Device, input: WidgetOperationInput): OperationSpec {
  const adapterId = inferAdapterId(input);
  const timeoutMs = input.timeoutMs ?? (input.mode === "mutate" ? 20_000 : 12_000);
  const brokerRequest = input.brokerRequest as ProtocolBrokerRequest | undefined;

  return {
    id: `widget-op-${randomUUID()}`,
    adapterId,
    kind: input.kind,
    mode: input.mode,
    timeoutMs,
    commandTemplate: input.commandTemplate,
    brokerRequest,
    args: input.args,
    expectedSemanticTarget: input.expectedSemanticTarget ?? device.name,
    safety: {
      dryRunSupported: false,
      requiresConfirmedRevert: input.kind === "network.config",
      criticality: criticalityForOperation(input.kind, input.mode),
    },
  };
}

function truncate(value: string, max = 12_000): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 15)}\n[truncated]`;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
    const normalized = key.toLowerCase();
    if (
      normalized.includes("authorization")
      || normalized.includes("cookie")
      || normalized.includes("token")
      || normalized.includes("password")
      || normalized.includes("secret")
    ) {
      return [key, "[redacted]"];
    }
    return [key, sanitizeValue(nested)];
  });
  return Object.fromEntries(entries);
}

function createWidgetOperationRun(args: {
  device: Device;
  widget: DeviceWidget;
  operation: OperationSpec;
  policyDecision: WidgetOperationResult["policyDecision"];
  policyReason: string;
  approved: boolean;
  result: WidgetOperationResult;
}): DeviceWidgetOperationRun {
  return {
    id: `widget-run-${randomUUID()}`,
    widgetId: args.widget.id,
    deviceId: args.device.id,
    widgetRevision: args.widget.revision,
    operationKind: args.operation.kind,
    operationMode: args.operation.mode,
    brokerProtocol: args.operation.brokerRequest?.protocol,
    status: args.result.status,
    phase: args.result.phase,
    proof: args.result.proof,
    approvalRequired: args.result.approvalRequired,
    policyDecision: args.policyDecision,
    policyReason: args.policyReason,
    approved: args.approved,
    idempotencyKey: args.result.idempotencyKey,
    summary: args.result.summary,
    output: truncate(args.result.output),
    operationJson: sanitizeValue(args.operation) as Record<string, unknown>,
    detailsJson: sanitizeValue(args.result.details) as Record<string, unknown>,
    createdAt: args.result.completedAt,
  };
}

async function runWidgetOperation(args: {
  device: Device;
  widget: DeviceWidget;
  input: WidgetOperationInput;
  approved?: boolean;
  persist: boolean;
}): Promise<WidgetOperationResult> {
  const operation = buildOperationSpec(args.device, args.input);
  const actionClass = actionClassForOperation(operation.kind, operation.mode);
  const evaluatedPolicy = evaluatePolicy(
    actionClass,
    args.device,
    stateStore.getPolicyRules(),
    stateStore.getMaintenanceWindows(),
    {
      blastRadius: "single-device",
      criticality: criticalityForOperation(operation.kind, operation.mode),
      lane: "A",
      recentFailures: 0,
      quarantineActive: false,
    },
  );
  const policyDecision = evaluatedPolicy.decision === "REQUIRE_APPROVAL"
    ? "ALLOW_AUTO"
    : evaluatedPolicy.decision;
  const policyReason = evaluatedPolicy.decision === "REQUIRE_APPROVAL"
    ? `Widget operations bypass manual approval. Original policy: ${evaluatedPolicy.reason}`
    : evaluatedPolicy.reason;
  const approved = false;

  if (policyDecision === "DENY") {
    const result: WidgetOperationResult = {
      ok: false,
      status: "blocked",
      phase: "blocked",
      proof: "none",
      summary: "Policy denied widget operation",
      output: `Policy denied operation: ${policyReason}`,
      details: {},
      gateResults: [],
      idempotencyKey: `${args.widget.id}:policy-denied`,
      policyDecision,
      policyReason,
      approvalRequired: false,
      approved,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    if (args.persist) {
      stateStore.addDeviceWidgetOperationRun(createWidgetOperationRun({
        device: args.device,
        widget: args.widget,
        operation,
        policyDecision,
        policyReason,
        approved,
        result,
      }));
    }
    return result;
  }

  const execution = await executeOperationWithGates(operation, args.device, {
    actor: "user",
    lane: "A",
    actionClass,
    blastRadius: "single-device",
    policyDecision,
    policyReason,
    approved,
    expectedStateHash: computeDeviceStateHash(args.device),
    runtimeSettings: stateStore.getRuntimeSettings(),
    recentFailures: 0,
    quarantineActive: false,
    allowProvidedCredentials: true,
    idempotencySeed: `${args.widget.id}:${args.device.id}:${Date.now()}`,
    params: buildWidgetExecutionParams(args.device, args.input),
  });

  const result: WidgetOperationResult = {
    ok: execution.ok,
    status: execution.status,
    phase: execution.phase,
    proof: execution.proof,
    summary: execution.summary,
    output: execution.output,
    details: execution.details,
    gateResults: execution.gateResults,
    idempotencyKey: execution.idempotencyKey,
    policyDecision,
    policyReason,
    approvalRequired: false,
    approved,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
  };

  if (args.persist) {
    stateStore.addDeviceWidgetOperationRun(createWidgetOperationRun({
      device: args.device,
      widget: args.widget,
      operation,
      policyDecision,
      policyReason,
      approved,
      result,
    }));

    await stateStore.addAction({
      actor: "user",
      kind: "config",
      message: `Widget operation executed from ${args.widget.name} on ${args.device.name}`,
      context: {
        deviceId: args.device.id,
        widgetId: args.widget.id,
        widgetSlug: args.widget.slug,
        operationKind: operation.kind,
        operationMode: operation.mode,
        adapterId: operation.adapterId,
        ok: result.ok,
        status: result.status,
        phase: result.phase,
        proof: result.proof,
        summary: result.summary,
        approved,
        policyDecision,
        policyReason,
      },
    });
  }

  return result;
}

export async function previewWidgetOperation(args: {
  device: Device;
  widget: DeviceWidget;
  input: WidgetOperationInput;
}): Promise<WidgetOperationResult> {
  return runWidgetOperation({
    ...args,
    persist: false,
  });
}

export async function executeWidgetOperation(args: {
  device: Device;
  widget: DeviceWidget;
  input: WidgetOperationInput;
  approved?: boolean;
}): Promise<WidgetOperationResult> {
  return runWidgetOperation({
    ...args,
    persist: true,
  });
}
