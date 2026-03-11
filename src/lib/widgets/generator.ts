import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { DeviceWidget, DeviceWidgetOperationRun, LLMProvider } from "@/lib/state/types";
import { buildDeviceWidgetContext } from "@/lib/widgets/context";
import { DeviceWidgetControlListSchema } from "@/lib/widgets/controls";
import { previewWidgetOperation, WidgetOperationSchema } from "@/lib/widgets/operations";
import { MAX_WIDGET_DESCRIPTION_LENGTH } from "@/lib/widgets/description";

const WIDGET_GENERATOR_MAX_OUTPUT_TOKENS = 7_000;
const WIDGET_GENERATOR_MAX_AUTO_CONTINUATIONS = 2;
const WIDGET_GENERATOR_AUTO_CONTINUE_FINISH_REASONS = new Set(["length", "tool-calls", "max-steps"]);
const WIDGET_STARTUP_VERIFICATION_MAX_OPERATIONS = 8;
const WIDGET_JSON_RESPONSE_SHAPE = [
  "{",
  '  "name": "string",',
  '  "description": "string",',
  '  "capabilities": ["context", "state", "device-control"],',
  '  "controls": [{ "id": "refresh-status", "label": "Refresh status", "kind": "button", "parameters": [], "execution": { "kind": "operation", "operation": { "mode": "read", "kind": "http.request", "adapterId": "http-api", "brokerRequest": { "protocol": "http", "method": "GET", "path": "/status" } } } }],',
  '  "html": "<div>...</div>",',
  '  "css": "string",',
  '  "js": "string",',
  '  "summary": "one short sentence for the operator"',
  "}",
].join("\n");

const GeneratedWidgetSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().min(1).max(MAX_WIDGET_DESCRIPTION_LENGTH),
  capabilities: z.array(z.enum(["context", "state", "device-control"])).min(1).max(3),
  controls: DeviceWidgetControlListSchema.default([]),
  html: z.string().min(1).max(24_000),
  css: z.string().max(24_000).default(""),
  js: z.string().min(1).max(48_000),
  summary: z.string().min(1).max(320),
});

type GeneratedWidget = z.infer<typeof GeneratedWidgetSchema>;
type DeviceWidgetGenerationContext = NonNullable<Awaited<ReturnType<typeof buildDeviceWidgetContext>>>;

function slugifyWidgetName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64) || "device-widget";
}

function extractFirstJsonObject(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Widget generator did not return JSON.");
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function normalizeFinishReason(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().toLowerCase();
  }
  return undefined;
}

function shouldAutoContinueForFinishReason(value: unknown): boolean {
  const reason = normalizeFinishReason(value);
  return reason ? WIDGET_GENERATOR_AUTO_CONTINUE_FINISH_REASONS.has(reason) : false;
}

function tryExtractFirstJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: extractFirstJsonObject(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: /did not return json/i.test(message)
        ? message
        : `Widget generator returned malformed JSON: ${message}`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpBrokerRequest(value: unknown): value is {
  protocol: "http";
  path?: string;
  body?: string;
  scheme?: string;
  insecureSkipVerify?: boolean;
} {
  return isRecord(value) && value.protocol === "http";
}

function collectGeneratedWidgetHttpRequests(widget: GeneratedWidget): Array<{
  source: string;
  path?: string;
  body?: string;
  scheme?: string;
  insecureSkipVerify?: boolean;
}> {
  return widget.controls
    .map((control) => {
      if (control.execution.kind !== "operation") {
        return null;
      }
      const request = control.execution.operation.brokerRequest;
      if (!isHttpBrokerRequest(request)) {
        return null;
      }
      return {
        source: `controls.${control.id}`,
        path: request.path,
        body: request.body,
        scheme: request.scheme,
        insecureSkipVerify: request.insecureSkipVerify,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}


function isWinrmBrokerRequest(value: unknown): value is {
  protocol: "winrm";
  port?: number;
  useSsl?: boolean;
  skipCertChecks?: boolean;
  authentication?: string;
} {
  return isRecord(value) && value.protocol === "winrm";
}

function collectGeneratedWidgetWinrmRequests(widget: GeneratedWidget): Array<{
  source: string;
  port?: number;
  useSsl?: boolean;
  skipCertChecks?: boolean;
  authentication?: string;
}> {
  return widget.controls
    .map((control) => {
      if (control.execution.kind !== "operation") {
        return null;
      }
      const request = control.execution.operation.brokerRequest;
      if (!isWinrmBrokerRequest(request)) {
        return null;
      }
      return {
        source: `controls.${control.id}`,
        port: request.port,
        useSsl: request.useSsl,
        skipCertChecks: request.skipCertChecks,
        authentication: request.authentication,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

function normalizeWinrmRequestSecurePreference(request: { port?: number; useSsl?: boolean }): boolean | undefined {
  if (typeof request.useSsl === "boolean") {
    return request.useSsl;
  }
  if (request.port === 5986) return true;
  if (request.port === 5985) return false;
  return undefined;
}

function isHueClipV2Context(
  context: DeviceWidgetGenerationContext,
): boolean {
  const httpCredential = context.credentials.find((credential) => credential.protocol.toLowerCase() === "http-api");
  const authMode = httpCredential?.auth?.mode?.toLowerCase();
  const headerName = httpCredential?.auth?.headerName?.toLowerCase();
  const deviceFingerprint = [
    context.device.name,
    context.device.vendor,
    context.device.metadata.ssdpFriendlyName,
    context.device.metadata.ssdpModelName,
    context.device.metadata.ssdpManufacturer,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return authMode === "api-key"
    && headerName === "hue-application-key"
    && /(philips hue|hue bridge|\bhue\b|signify)/i.test(deviceFingerprint);
}

type WidgetAccessMethod = DeviceWidgetGenerationContext["accessMethods"][number];

function accessMethodStatusRank(value: WidgetAccessMethod["status"]): number {
  switch (value) {
    case "validated":
      return 0;
    case "credentialed":
      return 1;
    case "observed":
      return 2;
    default:
      return 3;
  }
}

function preferredContextAccessMethod(context: DeviceWidgetGenerationContext, kind: string): WidgetAccessMethod | null {
  return context.accessMethods
    .filter((method) => method.kind === kind)
    .sort((left, right) => {
      if (left.selected !== right.selected) {
        return left.selected ? -1 : 1;
      }
      if (left.status !== right.status) {
        return accessMethodStatusRank(left.status) - accessMethodStatusRank(right.status);
      }
      if ((left.port ?? 0) !== (right.port ?? 0)) {
        return (left.port ?? 0) - (right.port ?? 0);
      }
      if (left.secure !== right.secure) {
        return left.secure ? -1 : 1;
      }
      return left.key.localeCompare(right.key);
    })[0] ?? null;
}

function buildWidgetGenerationHints(context: DeviceWidgetGenerationContext): string[] {
  const hints: string[] = [];
  const httpCredential = context.credentials.find((credential) => credential.protocol.toLowerCase() === "http-api");
  const preferredWinrm = preferredContextAccessMethod(context, "winrm");

  if (httpCredential?.auth?.appliedBySteward) {
    hints.push("Use the stored http-api credential exactly as described in context.credentials. Steward injects authentication automatically.");
    switch (httpCredential.auth.mode) {
      case "api-key":
        hints.push(`The device uses header-based API key auth (${httpCredential.auth.headerName ?? "X-API-Key"}). Do not put tokens in paths, query strings, HTML, JS, or control parameters.`);
        break;
      case "path-segment":
        hints.push(`The device uses path-segment auth. Use the logical API path only; Steward inserts the token after ${httpCredential.auth.pathPrefix ?? "/api"} automatically.`);
        break;
      case "query-param":
        hints.push(`The device uses query-param auth (${httpCredential.auth.queryParamName ?? "api_key"}). Do not hard-code tokens in widget code.`);
        break;
      default:
        break;
    }
  }

  if (preferredWinrm) {
    const port = preferredWinrm.port ?? (preferredWinrm.secure ? 5986 : 5985);
    const transportFields = [
      "protocol: 'winrm'",
      `port: ${port}`,
      ...(preferredWinrm.secure ? ["useSsl: true", "skipCertChecks: true"] : []),
      "command: 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory; Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free'",
    ].join(", ");
    hints.push(`This device already has a ${preferredWinrm.selected ? "selected " : ""}${preferredWinrm.status} WinRM access method on port ${port} with secure=${preferredWinrm.secure ? "true" : "false"}. Match that exact transport in widget controls.`);
    if (!preferredWinrm.secure) {
      hints.push("For this device, do not switch WinRM widget controls to HTTPS or Basic auth. Reuse the validated HTTP/5985 path instead.");
    }
    hints.push(`Preferred WinRM control shape for this device: { mode: 'read', kind: 'shell.command', adapterId: 'winrm', timeoutMs: 30000, brokerRequest: { ${transportFields} } }`);
  }

  if (isHueClipV2Context(context)) {
    hints.push("This device is a Philips Hue Bridge using CLIP v2 header auth.");
    hints.push("Use CLIP v2 endpoints only: /clip/v2/resource/light, /clip/v2/resource/room, and /clip/v2/resource/grouped_light.");
    hints.push("Never use legacy Hue v1 endpoints such as /api/lights, /api/groups, /api/scenes, /api/sensors, or /api/config.");
    hints.push("Use HTTPS on port 443 with brokerRequest.insecureSkipVerify=true for all Hue Bridge HTTP calls.");
    hints.push("For light writes use PUT /clip/v2/resource/light/{light_id} with CLIP v2 bodies such as {\"on\":{\"on\":true}}, {\"dimming\":{\"brightness\":42}}, or {\"color\":{\"xy\":{\"x\":0.3,\"y\":0.3}}}.");
    hints.push("For room grouping, match room.children[*].rid (device ids) to light.owner.rid. Room aggregate state lives under grouped_light where grouped_light.owner.rid equals the room id.");
    hints.push("For Hue brightness controls use dimming.brightness percentages from 0 to 100, not legacy bri 1-254 values.");
    hints.push("For Hue color controls use color.xy.x and color.xy.y values, not legacy hue/sat values.");
  }

  return hints;
}
function controlLooksLikeRefresh(control: GeneratedWidget["controls"][number]): boolean {
  return /\b(refresh|reload|sync|update)\b/i.test([
    control.id,
    control.label,
    control.description ?? "",
  ].join(" "));
}

function canAutoVerifyControl(control: GeneratedWidget["controls"][number]): boolean {
  return control.execution.kind === "operation"
    && control.execution.operation.mode === "read"
    && control.parameters.length === 0;
}

function validateGeneratedWidgetAgainstContext(
  widget: GeneratedWidget,
  context: DeviceWidgetGenerationContext,
): string[] {
  const issues: string[] = [];
  const httpRequests = collectGeneratedWidgetHttpRequests(widget);
  const winrmRequests = collectGeneratedWidgetWinrmRequests(widget);
  const preferredWinrm = preferredContextAccessMethod(context, "winrm");

  if (widget.controls.some((control) => control.execution.kind === "operation") && !widget.capabilities.includes("device-control")) {
    issues.push("Widgets with operation controls must include the device-control capability.");
  }

  if (preferredWinrm) {
    const preferredPort = preferredWinrm.port ?? (preferredWinrm.secure ? 5986 : 5985);
    for (const request of winrmRequests) {
      const requestSecure = normalizeWinrmRequestSecurePreference(request);
      if (request.port !== undefined && preferredWinrm.port !== undefined && request.port !== preferredWinrm.port) {
        issues.push(`${request.source} targets WinRM port ${request.port}, but the selected validated access method for this device is port ${preferredWinrm.port}.`);
      }
      if (requestSecure !== undefined && requestSecure !== preferredWinrm.secure) {
        issues.push(`${request.source} sets WinRM secure=${requestSecure}, but the selected validated access method for this device requires secure=${preferredWinrm.secure}.`);
      }
      if (!preferredWinrm.secure && request.authentication?.trim().toLowerCase() === "basic") {
        issues.push(`${request.source} forces Basic auth on WinRM even though this device's selected validated path is HTTP/${preferredPort}. Reuse the validated WinRM defaults instead.`);
      }
    }
  }

  for (const control of widget.controls) {
    if (!controlLooksLikeRefresh(control)) {
      continue;
    }
    if (control.execution.kind !== "operation") {
      issues.push(`Control ${control.id} looks like a refresh action but only mutates widget state. Refresh controls must execute a real read operation.`);
      continue;
    }
    if (control.execution.operation.mode !== "read") {
      issues.push(`Control ${control.id} looks like a refresh action but is not configured as a read operation.`);
    }
    if (control.parameters.length > 0) {
      issues.push(`Control ${control.id} looks like a refresh action but requires parameters. Refresh controls must be zero-parameter reads.`);
    }
  }

  for (const request of httpRequests) {
    if (request.scheme === "https" && request.insecureSkipVerify !== true) {
      issues.push(`${request.source} uses HTTPS without brokerRequest.insecureSkipVerify=true.`);
    }
  }

  if (/\bskipCertChecks\s*:/.test(widget.js)) {
    issues.push("Widget JavaScript uses skipCertChecks for HTTP requests; use insecureSkipVerify instead.");
  }

  if (!isHueClipV2Context(context)) {
    return issues;
  }

  for (const request of httpRequests) {
    const path = request.path ?? "";
    const body = request.body ?? "";
    if (path.startsWith("/api/")) {
      issues.push(`${request.source} uses legacy Hue v1 path ${path}; use /clip/v2/resource/... instead.`);
    }
    if (path.length > 0 && !path.startsWith("/clip/v2/resource/")) {
      issues.push(`${request.source} path ${path} is not a Hue CLIP v2 resource path.`);
    }
    if (/"bri"\s*:/.test(body)) {
      issues.push(`${request.source} uses legacy Hue bri payloads; use dimming.brightness percentages instead.`);
    }
    if (/"hue"\s*:/.test(body) || /"sat"\s*:/.test(body)) {
      issues.push(`${request.source} uses legacy Hue hue/sat payloads; use color.xy instead.`);
    }
  }

  if (/\/api\/(?:lights|groups|scenes|sensors|config)\b/.test(widget.js)) {
    issues.push("Widget JavaScript uses legacy Hue v1 /api/... paths.");
  }
  if (!/\/clip\/v2\/resource\//.test(widget.js)) {
    issues.push("Widget JavaScript does not reference Hue CLIP v2 resource paths.");
  }

  return issues;
}

function buildDraftWidgetForVerification(args: {
  context: DeviceWidgetGenerationContext;
  widget: GeneratedWidget;
  targetWidget?: DeviceWidget | null;
}): DeviceWidget {
  const now = new Date().toISOString();
  return {
    id: args.targetWidget?.id ?? `draft-widget-${slugifyWidgetName(args.widget.name)}`,
    deviceId: args.context.device.id,
    slug: args.targetWidget?.slug ?? slugifyWidgetName(args.widget.name),
    name: args.widget.name.trim(),
    description: args.widget.description.trim(),
    status: args.targetWidget?.status ?? "active",
    html: sanitizeHtml(args.widget.html),
    css: sanitizeCss(args.widget.css),
    js: sanitizeJs(args.widget.js),
    capabilities: args.widget.capabilities,
    controls: args.widget.controls as DeviceWidget["controls"],
    sourcePrompt: args.targetWidget?.sourcePrompt,
    createdBy: args.targetWidget?.createdBy ?? "steward",
    revision: args.targetWidget?.revision ?? 1,
    createdAt: args.targetWidget?.createdAt ?? now,
    updatedAt: now,
  };
}

function describeVerificationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createVerificationElement(tagName = "div"): Record<string, unknown> {
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const element: Record<string, unknown> = {
    nodeName: tagName.toUpperCase(),
    style: {},
    dataset: {},
    className: "",
    id: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    innerHTML: "",
    textContent: "",
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => false,
      contains: () => false,
    },
    appendChild: (child: unknown) => child,
    removeChild: (child: unknown) => child,
    replaceChildren: () => undefined,
    querySelector: () => createVerificationElement("div"),
    querySelectorAll: () => [],
    closest: () => null,
    focus: () => undefined,
    blur: () => undefined,
    setAttribute: (key: string, value: unknown) => {
      element[key] = value;
    },
    getAttribute: (key: string) => {
      const value = element[key];
      return typeof value === "string" ? value : null;
    },
    removeAttribute: (key: string) => {
      delete element[key];
    },
    addEventListener: (event: string, listener: (...args: unknown[]) => unknown) => {
      const existing = listeners.get(event) ?? new Set<(...args: unknown[]) => unknown>();
      existing.add(listener);
      listeners.set(event, existing);
    },
    removeEventListener: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.get(event)?.delete(listener);
    },
    dispatchEvent: (event: { type?: string }) => {
      const type = typeof event?.type === "string" ? event.type : "";
      const current = listeners.get(type);
      if (!current) {
        return true;
      }
      for (const listener of Array.from(current)) {
        listener(event);
      }
      return true;
    },
  };

  return new Proxy(element, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      if (prop === "firstChild" || prop === "lastChild" || prop === "firstElementChild") {
        return null;
      }
      return undefined;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value, receiver);
    },
  });
}

function unwrapVerificationResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.operationResult)) {
    return value.operationResult;
  }
  return value;
}

function normalizeVerificationHttpResponse(result: unknown): {
  body: string;
  json: unknown;
  statusCode: number | null;
  url: string;
} {
  const resolved = unwrapVerificationResult(result);
  const details = resolved && isRecord(resolved.details) ? resolved.details : null;
  const body = details && typeof details.responseBody === "string" ? details.responseBody : "";
  const json = details && Object.prototype.hasOwnProperty.call(details, "responseJson")
    ? details.responseJson
    : (() => {
      const trimmed = body.trim();
      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        return null;
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    })();
  return {
    body,
    json,
    statusCode: details && typeof details.statusCode === "number" ? details.statusCode : null,
    url: details && typeof details.url === "string" ? details.url : "",
  };
}

function normalizeVerificationMqttMessages(result: unknown): Array<Record<string, unknown>> {
  const resolved = unwrapVerificationResult(result);
  const details = resolved && isRecord(resolved.details) ? resolved.details : null;
  const messages = details && Array.isArray(details.messages) ? details.messages : [];
  return messages
    .filter((message): message is Record<string, unknown> => isRecord(message))
    .map((message) => {
      const payload = typeof message.payload === "string" ? message.payload : "";
      let json: unknown = null;
      if (payload.length > 0) {
        try {
          json = JSON.parse(payload);
        } catch {
          json = null;
        }
      }
      return {
        topic: typeof message.topic === "string" ? message.topic : "",
        payload,
        payloadBytes: typeof message.payloadBytes === "number" ? message.payloadBytes : payload.length,
        payloadTruncated: Boolean(message.payloadTruncated),
        qos: typeof message.qos === "number" ? message.qos : 0,
        retain: Boolean(message.retain),
        dup: Boolean(message.dup),
        json,
      };
    });
}

async function validateGeneratedWidgetStartupJs(args: {
  context: DeviceWidgetGenerationContext;
  widget: GeneratedWidget;
  draftWidget: DeviceWidget;
}): Promise<string[]> {
  if (args.widget.js.trim().length === 0) {
    return [];
  }

  const issues = new Set<string>();
  const documentElement = createVerificationElement("html");
  const bodyElement = createVerificationElement("body");
  const surfaceElement = createVerificationElement("div");
  const documentListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const windowListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const timeouts = new Map<number, () => unknown>();
  const intervals = new Map<number, () => unknown>();
  const animationFrames = new Map<number, (timestamp: number) => unknown>();
  let timerId = 1;
  let operationCount = 0;

  const addListener = (
    bucket: Map<string, Set<(...args: unknown[]) => unknown>>,
    event: string,
    listener: (...args: unknown[]) => unknown,
  ) => {
    const existing = bucket.get(event) ?? new Set<(...args: unknown[]) => unknown>();
    existing.add(listener);
    bucket.set(event, existing);
  };

  const invokeListeners = async (
    bucket: Map<string, Set<(...args: unknown[]) => unknown>>,
    event: string,
    payload?: unknown,
  ) => {
    for (const listener of Array.from(bucket.get(event) ?? [])) {
      try {
        await Promise.resolve(listener(payload));
      } catch (error) {
        issues.add(`Widget JavaScript listener for ${event} failed during verification: ${describeVerificationError(error)}`);
      }
    }
  };

  const flushMicrotasks = async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  };

  const previewStartupOperation = async (source: string, operation: unknown) => {
    operationCount += 1;
    if (operationCount > WIDGET_STARTUP_VERIFICATION_MAX_OPERATIONS) {
      throw new Error(`Widget startup triggered more than ${WIDGET_STARTUP_VERIFICATION_MAX_OPERATIONS} Steward operations during verification.`);
    }
    const parsed = WidgetOperationSchema.safeParse(operation);
    if (!parsed.success) {
      throw new Error(`Invalid startup operation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    const result = await previewWidgetOperation({
      device: args.context.device,
      widget: args.draftWidget,
      input: parsed.data,
    });
    if (!result.ok) {
      const detail = result.summary.trim().length > 0 ? result.summary.trim() : result.output.trim();
      issues.add(`Live verification failed for ${source}: ${detail || "unknown error"}`);
    }
    return result;
  };

  const toMqttOperation = (request: unknown) => {
    const source = isRecord(request) ? request : {};
    const {
      mode,
      timeoutMs,
      args: operationArgs,
      expectedSemanticTarget,
      ...brokerRequest
    } = source;
    const publishMessages = Array.isArray(brokerRequest.publishMessages) ? brokerRequest.publishMessages : [];
    return {
      mode: mode === "mutate" || mode === "read" ? mode : (publishMessages.length > 0 ? "mutate" : "read"),
      kind: "mqtt.message",
      adapterId: "mqtt",
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 10_000,
      brokerRequest: {
        protocol: "mqtt",
        ...brokerRequest,
      },
      ...(isRecord(operationArgs) ? { args: operationArgs } : {}),
      ...(typeof expectedSemanticTarget === "string" && expectedSemanticTarget.trim().length > 0
        ? { expectedSemanticTarget }
        : {}),
    };
  };

  const noop = () => undefined;
  const documentObject = {
    readyState: "complete",
    body: bodyElement,
    documentElement,
    createElement: (tagName: string) => createVerificationElement(tagName),
    createTextNode: (text: unknown) => ({ textContent: String(text ?? "") }),
    getElementById: (id: string) => (id === "steward-widget-surface" ? surfaceElement : createVerificationElement("div")),
    querySelector: () => createVerificationElement("div"),
    querySelectorAll: () => [],
    addEventListener: (event: string, listener: (...args: unknown[]) => unknown) => addListener(documentListeners, event, listener),
    removeEventListener: (event: string, listener: (...args: unknown[]) => unknown) => documentListeners.get(event)?.delete(listener),
  };

  const sandbox: Record<string, unknown> = {
    console: {
      log: noop,
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    },
    document: documentObject,
    navigator: { userAgent: "StewardWidgetVerifier/1.0" },
    location: { href: "https://steward.local/widget-verifier", origin: "https://steward.local" },
    performance: { now: () => Date.now() },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout: (callback: unknown) => {
      const id = timerId += 1;
      if (typeof callback === "function") {
        timeouts.set(id, callback as () => unknown);
      }
      return id;
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id);
    },
    setInterval: (callback: unknown) => {
      const id = timerId += 1;
      if (typeof callback === "function") {
        intervals.set(id, callback as () => unknown);
      }
      return id;
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
    requestAnimationFrame: (callback: unknown) => {
      const id = timerId += 1;
      if (typeof callback === "function") {
        animationFrames.set(id, callback as (timestamp: number) => unknown);
      }
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      animationFrames.delete(id);
    },
    fetch: () => Promise.reject(new Error("Widgets must use StewardWidget.runOperation instead of direct fetch calls.")),
    ResizeObserver: class {
      observe = noop;
      disconnect = noop;
    },
    MutationObserver: class {
      observe = noop;
      disconnect = noop;
    },
  };

  const windowObject = {
    ...sandbox,
    addEventListener: (event: string, listener: (...args: unknown[]) => unknown) => addListener(windowListeners, event, listener),
    removeEventListener: (event: string, listener: (...args: unknown[]) => unknown) => windowListeners.get(event)?.delete(listener),
    StewardWidget: {
      context: args.context,
      controls: args.draftWidget.controls,
      getContext: async () => args.context,
      refreshContext: async () => args.context,
      onContext: () => noop,
      getControls: async () => args.draftWidget.controls,
      getOperations: async () => [],
      getState: async () => ({}),
      setState: async (nextState: unknown) => nextState,
      runOperation: async (operation: unknown) => {
        const result = await previewStartupOperation("widget JavaScript startup operation", operation);
        if (!result.ok) {
          const error = new Error(result.summary || result.output || "Widget operation failed.");
          Object.defineProperty(error, "result", { value: result, enumerable: false, configurable: true });
          throw error;
        }
        return result;
      },
      runOperationDetailed: async (operation: unknown) => previewStartupOperation("widget JavaScript startup operation", operation),
      buildMqttOperation: (request: unknown) => toMqttOperation(request),
      runMqtt: async (request: unknown) => previewStartupOperation("widget JavaScript startup MQTT operation", toMqttOperation(request)),
      invokeControl: async (controlId: string) => {
        const control = args.draftWidget.controls.find((candidate) => candidate.id === controlId);
        if (!control) {
          throw new Error(`Unknown widget control: ${controlId}`);
        }
        if (control.execution.kind !== "operation") {
          return { ok: true, status: "succeeded", summary: "Control verified", output: "", details: {} };
        }
        const result = await previewStartupOperation(`widget JavaScript startup control ${controlId}`, control.execution.operation);
        if (!result.ok) {
          const error = new Error(result.summary || result.output || "Widget control failed.");
          Object.defineProperty(error, "result", { value: result, enumerable: false, configurable: true });
          throw error;
        }
        return result;
      },
      invokeControlDetailed: async (controlId: string) => {
        const control = args.draftWidget.controls.find((candidate) => candidate.id === controlId);
        if (!control) {
          throw new Error(`Unknown widget control: ${controlId}`);
        }
        if (control.execution.kind !== "operation") {
          return { ok: true, status: "succeeded", summary: "Control verified", output: "", details: {} };
        }
        return previewStartupOperation(`widget JavaScript startup control ${controlId}`, control.execution.operation);
      },
      getControlOperationResult: (result: unknown) => unwrapVerificationResult(result),
      getControlOutput: (result: unknown) => {
        const resolved = unwrapVerificationResult(result);
        return resolved && typeof resolved.output === "string" ? resolved.output : "";
      },
      getMqttMessages: (result: unknown) => normalizeVerificationMqttMessages(result),
      getHttpResponse: (result: unknown) => normalizeVerificationHttpResponse(result),
      getHttpJson: (result: unknown) => normalizeVerificationHttpResponse(result).json,
      setLayout: () => ({ mode: "content" }),
      setStatus: noop,
      ready: noop,
    },
  };

  sandbox.window = windowObject;
  sandbox.self = windowObject;
  sandbox.globalThis = windowObject;
  sandbox.HTMLElement = class {};
  sandbox.Event = class {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  };
  sandbox.CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  Object.assign(windowObject, {
    HTMLElement: sandbox.HTMLElement,
    Event: sandbox.Event,
    CustomEvent: sandbox.CustomEvent,
  });

  try {
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new vm.Script(args.widget.js, { filename: "widget-verification.js" });
    script.runInContext(context, { timeout: 1_000 });
    await flushMicrotasks();
    await invokeListeners(documentListeners, "DOMContentLoaded", { type: "DOMContentLoaded" });
    await invokeListeners(windowListeners, "load", { type: "load" });
    await flushMicrotasks();

    for (let pass = 0; pass < 3; pass += 1) {
      const nextTimeouts = Array.from(timeouts.values());
      timeouts.clear();
      for (const callback of nextTimeouts) {
        try {
          await Promise.resolve(callback());
        } catch (error) {
          issues.add(`Widget JavaScript timeout callback failed during verification: ${describeVerificationError(error)}`);
        }
      }

      const nextIntervals = Array.from(intervals.values());
      intervals.clear();
      for (const callback of nextIntervals) {
        try {
          await Promise.resolve(callback());
        } catch (error) {
          issues.add(`Widget JavaScript interval callback failed during verification: ${describeVerificationError(error)}`);
        }
      }

      const nextFrames = Array.from(animationFrames.values());
      animationFrames.clear();
      for (const callback of nextFrames) {
        try {
          await Promise.resolve(callback(Date.now()));
        } catch (error) {
          issues.add(`Widget JavaScript animation callback failed during verification: ${describeVerificationError(error)}`);
        }
      }

      await flushMicrotasks();
      if (nextTimeouts.length === 0 && nextIntervals.length === 0 && nextFrames.length === 0) {
        break;
      }
    }
  } catch (error) {
    issues.add(`Widget JavaScript failed during startup verification: ${describeVerificationError(error)}`);
  }

  return Array.from(issues);
}

async function validateGeneratedWidgetOperationally(args: {
  context: DeviceWidgetGenerationContext;
  widget: GeneratedWidget;
  targetWidget?: DeviceWidget | null;
}): Promise<string[]> {
  const issues: string[] = [];
  const draftWidget = buildDraftWidgetForVerification(args);
  const startupIssues = await validateGeneratedWidgetStartupJs({
    context: args.context,
    widget: args.widget,
    draftWidget,
  });
  issues.push(...startupIssues);

  const verifiableControls = args.widget.controls.filter(canAutoVerifyControl).slice(0, 6);
  for (const control of verifiableControls) {
    if (control.execution.kind !== "operation") {
      continue;
    }
    const result = await previewWidgetOperation({
      device: args.context.device,
      widget: draftWidget,
      input: control.execution.operation,
    });
    if (!result.ok) {
      const detail = result.summary.trim().length > 0 ? result.summary.trim() : result.output.trim();
      issues.push(`Live verification failed for control ${control.id}: ${detail || "unknown error"}`);
    }
  }
  return issues;
}

async function autoContinueWidgetGeneration(args: {
  model: Awaited<ReturnType<typeof buildLanguageModel>>;
  systemPrompt: string;
  userPrompt: string;
  initialText: string;
  initialFinishReason: unknown;
}): Promise<{ text: string; truncated: boolean }> {
  let text = args.initialText;
  let finishReason = args.initialFinishReason;

  for (let i = 0; i < WIDGET_GENERATOR_MAX_AUTO_CONTINUATIONS; i++) {
    if (!shouldAutoContinueForFinishReason(finishReason)) {
      return { text, truncated: false };
    }

    const continuation = await generateText({
      model: args.model,
      system: args.systemPrompt,
      messages: [
        { role: "user", content: args.userPrompt },
        { role: "assistant", content: text },
        {
          role: "user",
          content: "Continue exactly where you left off. Do not repeat prior content. Return only the continuation of the same JSON object.",
        },
      ],
      temperature: 0.15,
      maxOutputTokens: WIDGET_GENERATOR_MAX_OUTPUT_TOKENS,
    });

    if (continuation.text.trim().length === 0) {
      return { text, truncated: true };
    }

    text += continuation.text;
    finishReason = await Promise.resolve((continuation as { finishReason?: unknown }).finishReason);
  }

  return { text, truncated: shouldAutoContinueForFinishReason(finishReason) };
}

async function repairGeneratedWidgetJson(args: {
  model: Awaited<ReturnType<typeof buildLanguageModel>>;
  rawText: string;
  parseError: string;
}): Promise<{ text: string; truncated: boolean }> {
  const repairSystemPrompt = [
    "You repair malformed JSON for Steward device widgets.",
    "Return JSON only. No markdown. No code fences.",
    "Keep the widget behavior and intent as close as possible to the source.",
    "If the source appears truncated, complete it conservatively so the JSON is valid and the widget remains usable.",
    "Ensure every control parameter includes key, label, and type.",
    "",
    "Return this JSON shape:",
    WIDGET_JSON_RESPONSE_SHAPE,
  ].join("\n");

  const repairUserPrompt = [
    "The following widget-generation output failed to parse as JSON.",
    `Parse error: ${args.parseError}`,
    "Repair it into one valid JSON object.",
    "",
    "Malformed output:",
    args.rawText,
  ].join("\n");

  const repairResult = await generateText({
    model: args.model,
    system: repairSystemPrompt,
    prompt: repairUserPrompt,
    temperature: 0,
    maxOutputTokens: WIDGET_GENERATOR_MAX_OUTPUT_TOKENS,
  });

  const repairFinishReason = await Promise.resolve((repairResult as { finishReason?: unknown }).finishReason);
  return autoContinueWidgetGeneration({
    model: args.model,
    systemPrompt: repairSystemPrompt,
    userPrompt: repairUserPrompt,
    initialText: repairResult.text,
    initialFinishReason: repairFinishReason,
  });
}

async function repairGeneratedWidgetForContextIssues(args: {
  model: Awaited<ReturnType<typeof buildLanguageModel>>;
  systemPrompt: string;
  currentWidget: GeneratedWidget;
  issues: string[];
}): Promise<{ text: string; truncated: boolean }> {
  const repairUserPrompt = [
    "Revise this widget JSON so it fully satisfies the required device-specific rules below while preserving the requested functionality.",
    "",
    "Issues to fix:",
    ...args.issues.map((issue) => `- ${issue}`),
    "",
    "Current widget JSON:",
    JSON.stringify(args.currentWidget, null, 2),
  ].join("\n");

  const repairResult = await generateText({
    model: args.model,
    system: args.systemPrompt,
    prompt: repairUserPrompt,
    temperature: 0.05,
    maxOutputTokens: WIDGET_GENERATOR_MAX_OUTPUT_TOKENS,
  });

  const repairFinishReason = await Promise.resolve((repairResult as { finishReason?: unknown }).finishReason);
  return autoContinueWidgetGeneration({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userPrompt: repairUserPrompt,
    initialText: repairResult.text,
    initialFinishReason: repairFinishReason,
  });
}

async function repairGeneratedWidgetForSchemaIssues(args: {
  model: Awaited<ReturnType<typeof buildLanguageModel>>;
  systemPrompt: string;
  currentValue: unknown;
  issues: string;
}): Promise<{ text: string; truncated: boolean }> {
  const repairUserPrompt = [
    "Revise this widget JSON so it satisfies Steward's schema exactly while preserving the requested functionality.",
    "Normalize common mistakes such as lowercase HTTP methods, uppercase schemes, numeric ports serialized as strings, and malformed control execution objects.",
    "If a control cannot be repaired safely, remove that control instead of leaving invalid schema.",
    "If execution.kind='state', execution.patch must be an object.",
    "If execution.kind='operation', execution.operation must be valid.",
    "Every control parameter must include key, label, and type.",
    "",
    `Schema issues: ${args.issues}`,
    "",
    "Current widget JSON:",
    JSON.stringify(args.currentValue, null, 2),
  ].join("\n");

  const repairResult = await generateText({
    model: args.model,
    system: args.systemPrompt,
    prompt: repairUserPrompt,
    temperature: 0,
    maxOutputTokens: WIDGET_GENERATOR_MAX_OUTPUT_TOKENS,
  });

  const repairFinishReason = await Promise.resolve((repairResult as { finishReason?: unknown }).finishReason);
  return autoContinueWidgetGeneration({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userPrompt: repairUserPrompt,
    initialText: repairResult.text,
    initialFinishReason: repairFinishReason,
  });
}

function stripWrapperTag(html: string, tag: string): string {
  const open = new RegExp(`^\\s*<${tag}[^>]*>`, "i");
  const close = new RegExp(`</${tag}>\\s*$`, "i");
  return html.replace(open, "").replace(close, "").trim();
}

function sanitizeHtml(html: string): string {
  let next = html.trim();
  next = next.replace(/<!doctype[^>]*>/gi, "").trim();
  next = stripWrapperTag(next, "html");
  next = stripWrapperTag(next, "body");
  next = next.replace(/<script[\s\S]*?<\/script>/gi, "").trim();
  next = next.replace(/<style[\s\S]*?<\/style>/gi, "").trim();
  return next;
}

function sanitizeCss(css: string): string {
  return css.replace(/<style[^>]*>/gi, "").replace(/<\/style>/gi, "").trim();
}

function sanitizeJs(js: string): string {
  return js.replace(/<script[^>]*>/gi, "").replace(/<\/script>/gi, "").trim();
}

function summarizeSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function summarizeWidgetRuns(runs: DeviceWidgetOperationRun[]): Array<Record<string, unknown>> {
  return runs.map((run) => ({
    createdAt: run.createdAt,
    operationKind: run.operationKind,
    operationMode: run.operationMode,
    brokerProtocol: run.brokerProtocol,
    status: run.status,
    phase: run.phase,
    proof: run.proof,
    summary: run.summary,
    policyDecision: run.policyDecision,
    approved: run.approved,
    output: run.output.length > 1_200 ? `${run.output.slice(0, 1_200)}\n[truncated]` : run.output,
    details: run.detailsJson,
  }));
}

export interface GenerateDeviceWidgetInput {
  deviceId: string;
  prompt: string;
  provider: LLMProvider;
  model?: string;
  actor?: DeviceWidget["createdBy"];
  targetWidgetId?: string;
  targetWidgetSlug?: string;
  verificationMode?: "strict" | "warn-on-connectivity";
}

export interface GenerateDeviceWidgetResult {
  widget: DeviceWidget;
  updatedExisting: boolean;
  summary: string;
  warnings: string[];
}

function isConnectivityVerificationIssue(issue: string): boolean {
  const normalized = issue.toLowerCase();
  return normalized.includes("winrm transport connection failed")
    || normalized.includes("winrm listener responded but remote powershell session failed")
    || normalized.includes("wmi command failed")
    || normalized.includes("smb command failed")
    || normalized.includes("rpc server is unavailable")
    || normalized.includes("network name is no longer available");
}

export async function generateAndStoreDeviceWidget(
  input: GenerateDeviceWidgetInput,
): Promise<GenerateDeviceWidgetResult> {
  const verificationMode = input.verificationMode ?? "strict";
  const context = await buildDeviceWidgetContext(input.deviceId);
  if (!context) {
    throw new Error("Device not found.");
  }

  const targetWidget = input.targetWidgetId
    ? stateStore.getDeviceWidgetById(input.targetWidgetId)
    : input.targetWidgetSlug
      ? stateStore.getDeviceWidgetBySlug(input.deviceId, input.targetWidgetSlug)
      : null;
  if (targetWidget && targetWidget.deviceId !== input.deviceId) {
    throw new Error("Target widget does not belong to the requested device.");
  }
  const targetWidgetState = targetWidget
    ? stateStore.getDeviceWidgetRuntimeState(targetWidget.id)?.stateJson ?? {}
    : null;
  const targetWidgetRuns = targetWidget
    ? summarizeWidgetRuns(stateStore.getDeviceWidgetOperationRuns(targetWidget.id, 12))
    : [];
  const generationHints = buildWidgetGenerationHints(context);

  const model = await buildLanguageModel(input.provider, input.model);
  const systemPrompt = [
      "You generate persistent device widgets for Steward.",
      "Return JSON only. No markdown. No code fences.",
      "The widget will be stored and rendered in a sandboxed iframe on the device page.",
      "Do not reference external scripts, CDNs, fonts, images, or network APIs directly.",
      "Use only the runtime contract below.",
      "HTML must omit <script>, <style>, <html>, and <body> tags.",
      "JavaScript must be self-contained and robust if data is missing.",
      "Every meaningful user-controllable element in the widget must be exposed in the controls manifest below so Steward can operate it through chat or automation without scraping the DOM.",
      "Do not hide device actions behind anonymous click handlers. If the user can click/toggle/set it, add a matching control definition unless it is purely cosmetic and has no persisted or operational effect.",
      "Prefer plain DOM APIs. No frameworks.",
      "Make the widget responsive, production-quality, and app-like by default.",
      "Prefer layouts that adapt cleanly to narrow panels, tablets, and desktop widths without horizontal scrolling.",
      "Do not hard-code desktop-only viewport sizes or require a fixed wide canvas.",
      "Default to compact responsive app surfaces that fit naturally inside the device page.",
      "If the requested widget is a dashboard, console, or other surface where vertical scrolling is expected, preserve scrolling instead of clipping content or forcing everything above the fold.",
      "Pick the minimal capability set needed.",
      targetWidget
        ? "You are revising an existing widget. Keep it persistent and compatible with the prior widget unless the user explicitly asked to rename or repurpose it."
        : "You are creating a new widget.",
      "",
      "Runtime contract available inside widget JS:",
      "- window.StewardWidget.context: initial device widget context object.",
      "- await window.StewardWidget.getContext(): fetch latest context.",
      "- await window.StewardWidget.refreshContext(): refresh context from Steward and return it.",
      "- const unsubscribe = window.StewardWidget.onContext((context) => { ... }): subscribe to context refreshes.",
      "- window.StewardWidget.controls: standard control manifest for this widget.",
      "- await window.StewardWidget.getControls(): fetch the latest control manifest.",
      "- await window.StewardWidget.invokeControl(controlId, input?): execute a control and throw on failure.",
      "- await window.StewardWidget.invokeControlDetailed(controlId, input?): execute a control and always resolve with the structured result.",
      "- window.StewardWidget.getControlOperationResult(result): extract the nested operation result returned by invokeControlDetailed() for operation-backed controls.",
      "- window.StewardWidget.getControlOutput(result): extract the raw command/output text from invokeControlDetailed() for operation-backed controls.",
      "- await window.StewardWidget.getOperations({ scope: 'widget' | 'device', limit }): fetch recent widget operation history.",
      "- await window.StewardWidget.getState(): load persisted JSON widget state.",
      "- await window.StewardWidget.setState(nextState): persist JSON widget state.",
      "- await window.StewardWidget.runOperation(operation): execute a generic device operation through Steward. This throws when Steward cannot prove success or when approval is denied. Failed throws include error.result.",
      "- await window.StewardWidget.runOperationDetailed(operation): same as runOperation but always resolves with a structured result object, including failures and inconclusive results.",
      "- window.StewardWidget.buildMqttOperation(request): build a generic Steward MQTT operation from a concise request object.",
      "- await window.StewardWidget.runMqtt(request): execute an MQTT or MQTTS exchange through Steward and return the structured result.",
      "- window.StewardWidget.getMqttMessages(result): extract structured MQTT messages from result.details.messages and attach json when payload parses as JSON.",
      "- window.StewardWidget.getHttpResponse(result): extract structured HTTP response data { body, json, statusCode, url } from a widget operation result.",
      "- window.StewardWidget.getHttpJson(result): shortcut for structured HTTP JSON response bodies when available.",
      "- window.StewardWidget.setLayout({ mode: 'content' | 'scroll' }): choose auto-sized content mode or a fixed-height scrollable viewport. Use mode='scroll' for dashboards or long monitoring surfaces.",
      "- window.StewardWidget.setStatus(text): update host-visible runtime status.",
      "",
      "runOperation(operation) supports the existing Steward operation model.",
      "Structured operation results include: ok, status, phase, proof, summary, output, details, policyDecision, policyReason, approvalRequired.",
      "invokeControlDetailed() returns a DeviceWidgetControlResult. For operation-backed controls, raw command output lives under result.operationResult.output, not result.output. Prefer getControlOutput()/getControlOperationResult() instead of guessing.",
      "For HTTP operations, details.responseBody contains the raw response body and details.responseJson contains parsed JSON when the body is valid JSON. Prefer getHttpResponse()/getHttpJson() instead of parsing result.output.",
      "MQTT operation results include details.messages when responses are collected. Prefer window.StewardWidget.getMqttMessages(result) instead of parsing output text.",
      "For PowerShell/WinRM commands that emit JSON, set $ProgressPreference='SilentlyContinue' before writing output so progress CLIXML does not corrupt JSON parsing.",
      "Operation template interpolation resolves {{host}} automatically and any scalar key provided in operation.args.",
      "Stored device credentials are applied by Steward inside the broker. Never embed credential secrets, usernames, bearer tokens, API keys, or placeholders such as {{apiKey}} in widget code.",
      "If context.credentials includes an http-api credential with auth.appliedBySteward=true, rely on the broker to attach auth automatically.",
      "For http-api auth.mode='path-segment', use the logical API path (for example '/api/groups'); Steward inserts the stored token after auth.pathPrefix automatically.",
      "For HTTP broker requests, the TLS skip flag is brokerRequest.insecureSkipVerify. Do not use skipCertChecks for HTTP operations.",
      "If context.accessMethods includes a selected or validated transport for the protocol you need, mirror that port and TLS setting instead of copying a generic example.",
      `Keep widget descriptions short and operator-facing (max ${MAX_WIDGET_DESCRIPTION_LENGTH} chars). Do not mention styling, transport, auth, or verification details in description text.`,
      "Use verification-oriented flows. For opaque write operations, prefer runOperationDetailed() and verify with a follow-up read when possible.",
      "For WebSocket writes, brokerRequest.successStrategy controls what counts as success:",
      "- transport: opening the socket and sending messages is enough.",
      "- response: at least one response frame must be received.",
      "- expectation: expectRegex must match the collected response frames.",
      "- auto: Steward chooses the safest default, which is usually response for mutating WebSocket messages.",
      "MQTT uses the same successStrategy values. Subscribe first, then publish only when the device expects a request topic trigger.",
      "Use successStrategy: 'transport' only when the protocol truly has no observable acknowledgement surface.",
      "Useful examples:",
      "- HTTP GET: { mode: 'read', kind: 'http.request', adapterId: 'http-api', timeoutMs: 8000, brokerRequest: { protocol: 'http', method: 'GET', scheme: 'http', port: 80, path: '/status' } }",
      "- HTTP POST: { mode: 'mutate', kind: 'http.request', adapterId: 'http-api', timeoutMs: 8000, brokerRequest: { protocol: 'http', method: 'POST', scheme: 'http', port: 8080, path: '/api/power', body: '{\"state\":\"on\"}', headers: { 'content-type': 'application/json' } } }",
      "- WebSocket message with response proof: { mode: 'mutate', kind: 'websocket.message', adapterId: 'http-api', timeoutMs: 8000, brokerRequest: { protocol: 'websocket', scheme: 'ws', port: 8001, path: '/ws', query: { token: 'abc' }, messages: ['{\"type\":\"ping\"}'], sendOn: 'open', collectMessages: 3, responseTimeoutMs: 1200, successStrategy: 'response' } }",
      "- WebSocket message with explicit verification: { mode: 'mutate', kind: 'websocket.message', adapterId: 'http-api', timeoutMs: 8000, brokerRequest: { protocol: 'websocket', scheme: 'ws', port: 8001, path: '/ws', messages: ['{\"type\":\"ping\"}'], expectRegex: 'pong', successStrategy: 'expectation' } }",
      "- MQTT read + request/response: { mode: 'read', kind: 'mqtt.message', adapterId: 'mqtt', timeoutMs: 10000, args: { deviceTopic: 'example/device-42' }, brokerRequest: { protocol: 'mqtt', scheme: 'mqtts', port: 8883, subscribeTopics: ['{{deviceTopic}}/telemetry'], publishMessages: [{ topic: '{{deviceTopic}}/command', payload: '{\"action\":\"status\"}' }], collectMessages: 1, responseTimeoutMs: 3000, successStrategy: 'response', insecureSkipVerify: true } }",
      "- MQTT widget helper pattern: const result = await window.StewardWidget.runMqtt({ scheme: 'mqtts', port: 8883, args: { deviceTopic: 'example/device-42' }, subscribeTopics: ['{{deviceTopic}}/telemetry'], publishMessages: [{ topic: '{{deviceTopic}}/command', payload: '{\"action\":\"status\"}' }], collectMessages: 1, responseTimeoutMs: 3000, successStrategy: 'response', insecureSkipVerify: true }); const messages = window.StewardWidget.getMqttMessages(result);",
      "- Linux telemetry over SSH: { mode: 'read', kind: 'shell.command', adapterId: 'ssh', timeoutMs: 30000, brokerRequest: { protocol: 'ssh', argv: ['sh', '-lc', 'uptime; free -m; df -h'] } }",
      "- Windows telemetry over WinRM: { mode: 'read', kind: 'shell.command', adapterId: 'winrm', timeoutMs: 30000, brokerRequest: { protocol: 'winrm', command: 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory; Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free' } }",
      "Do not invent host-platform transport constraints. Use the device context and the selected or validated access method instead of generic WinRM assumptions.",
      "",
      "Capabilities:",
      "- context: required if widget reads context.",
      "- state: required if widget stores local state.",
      "- device-control: required if widget calls runOperation.",
      "",
      "Control manifest rules:",
      "- controls is always required and may be [] only when the widget truly has no meaningful controls.",
      "- Use a stable control id such as 'power-toggle', 'refresh-status', or 'set-brightness'.",
      "- If the widget displays live device data, include at least one no-parameter read control such as 'refresh-status' so Steward can verify and refresh it without DOM interaction.",
      "- kind is one of button, toggle, select, or form.",
      "- parameters must describe every input Steward needs to execute the control without the DOM.",
      "- Every parameter object must include key, label, and type. Use key for the machine-readable input name. Do not substitute name or id for key.",
      "- execution.kind='operation' should be used for device actions via Steward's operation model.",
      "- execution.kind='state' should be used for persisted widget state changes only.",
      "- If any control uses execution.kind='operation', capabilities must include device-control.",
      "- Refresh, reload, sync, or update controls must use execution.kind='operation' with mode='read' and no parameters.",
      "- Never fake live refresh by only mutating widget state, timestamps, or labels.",
      "- HTTP brokerRequest.method must be uppercase GET, POST, PUT, PATCH, or DELETE.",
      "- HTTP brokerRequest.scheme must be lowercase http or https.",
      "- brokerRequest.port must be a number, not a string.",
      "- state executions must include execution.patch as an object.",
      "- For toggles/selects/forms, the widget UI should call invokeControl/invokeControlDetailed instead of duplicating operation templates inline.",
      ...(generationHints.length > 0
        ? [
          "",
          "Device-specific generation hints:",
          ...generationHints.map((hint) => `- ${hint}`),
          "If any device-specific hint conflicts with a generic example, follow the device-specific hint.",
        ]
        : []),
      "",
      "Return this JSON shape:",
      WIDGET_JSON_RESPONSE_SHAPE,
    ].join("\n");
  const userPrompt = [
      `User request: ${input.prompt}`,
      "",
      "Device widget context JSON:",
      JSON.stringify(context, null, 2),
      "",
      "Existing widgets on this device:",
      JSON.stringify(context.widgets, null, 2),
      "",
      targetWidget
        ? [
          "Current target widget source:",
          JSON.stringify({
            id: targetWidget.id,
            slug: targetWidget.slug,
            name: targetWidget.name,
            description: targetWidget.description,
            capabilities: targetWidget.capabilities,
            controls: targetWidget.controls,
            html: targetWidget.html,
            css: targetWidget.css,
            js: targetWidget.js,
            revision: targetWidget.revision,
          }, null, 2),
          "",
          "Current target widget runtime state JSON:",
          JSON.stringify(targetWidgetState, null, 2),
          "",
          "Current target widget recent operation runs:",
          JSON.stringify(targetWidgetRuns, null, 2),
        ].join("\n")
        : "Current target widget source: none",
    ].join("\n");

  const result = await generateText({
    model,
    temperature: 0.15,
    maxOutputTokens: WIDGET_GENERATOR_MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    prompt: userPrompt,
  });

  const finishReason = await Promise.resolve((result as { finishReason?: unknown }).finishReason);
  const generatedText = await autoContinueWidgetGeneration({
    model,
    systemPrompt,
    userPrompt,
    initialText: result.text,
    initialFinishReason: finishReason,
  });

  let extracted = tryExtractFirstJsonObject(generatedText.text);
  let jsonSourceWasTruncated = generatedText.truncated;
  if (!extracted.ok) {
    const repaired = await repairGeneratedWidgetJson({
      model,
      rawText: generatedText.text,
      parseError: extracted.error,
    });
    extracted = tryExtractFirstJsonObject(repaired.text);
    jsonSourceWasTruncated = jsonSourceWasTruncated || repaired.truncated;
    if (!extracted.ok) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`${extracted.error}${truncationNote}`);
    }
  }

  const parsedResult = GeneratedWidgetSchema.safeParse(extracted.value);
  if (!parsedResult.success) {
    const repaired = await repairGeneratedWidgetForSchemaIssues({
      model,
      systemPrompt,
      currentValue: extracted.value,
      issues: summarizeSchemaIssues(parsedResult.error),
    });
    jsonSourceWasTruncated = jsonSourceWasTruncated || repaired.truncated;
    const repairedExtracted = tryExtractFirstJsonObject(repaired.text);
    if (!repairedExtracted.ok) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`${repairedExtracted.error}${truncationNote}`);
    }
    const repairedParsed = GeneratedWidgetSchema.safeParse(repairedExtracted.value);
    if (!repairedParsed.success) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`Widget generator returned invalid JSON: ${summarizeSchemaIssues(repairedParsed.error)}${truncationNote}`);
    }
    extracted = { ok: true, value: repairedExtracted.value };
  }
  let parsed = GeneratedWidgetSchema.parse(extracted.value);

  let contextIssues = validateGeneratedWidgetAgainstContext(parsed, context);
  if (contextIssues.length > 0) {
    const repaired = await repairGeneratedWidgetForContextIssues({
      model,
      systemPrompt,
      currentWidget: parsed,
      issues: contextIssues,
    });
    jsonSourceWasTruncated = jsonSourceWasTruncated || repaired.truncated;
    const repairedExtracted = tryExtractFirstJsonObject(repaired.text);
    if (!repairedExtracted.ok) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`${repairedExtracted.error}${truncationNote}`);
    }
    const repairedParsed = GeneratedWidgetSchema.safeParse(repairedExtracted.value);
    if (!repairedParsed.success) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`Widget generator returned invalid JSON: ${summarizeSchemaIssues(repairedParsed.error)}${truncationNote}`);
    }
    parsed = repairedParsed.data;
    contextIssues = validateGeneratedWidgetAgainstContext(parsed, context);
    if (contextIssues.length > 0) {
      throw new Error(`Widget generator returned context-incompatible JSON: ${contextIssues.slice(0, 8).join("; ")}`);
    }
  }

  let operationalIssues = await validateGeneratedWidgetOperationally({
    context,
    widget: parsed,
    targetWidget,
  });
  const verificationWarnings: string[] = [];
  if (operationalIssues.length > 0) {
    const repaired = await repairGeneratedWidgetForContextIssues({
      model,
      systemPrompt,
      currentWidget: parsed,
      issues: operationalIssues,
    });
    jsonSourceWasTruncated = jsonSourceWasTruncated || repaired.truncated;
    const repairedExtracted = tryExtractFirstJsonObject(repaired.text);
    if (!repairedExtracted.ok) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`${repairedExtracted.error}${truncationNote}`);
    }
    const repairedParsed = GeneratedWidgetSchema.safeParse(repairedExtracted.value);
    if (!repairedParsed.success) {
      const truncationNote = jsonSourceWasTruncated ? " The model response may have been truncated." : "";
      throw new Error(`Widget generator returned invalid JSON: ${summarizeSchemaIssues(repairedParsed.error)}${truncationNote}`);
    }
    parsed = repairedParsed.data;
    contextIssues = validateGeneratedWidgetAgainstContext(parsed, context);
    if (contextIssues.length > 0) {
      throw new Error(`Widget generator returned context-incompatible JSON: ${contextIssues.slice(0, 8).join("; ")}`);
    }
    operationalIssues = await validateGeneratedWidgetOperationally({
      context,
      widget: parsed,
      targetWidget,
    });
    if (operationalIssues.length > 0) {
      const connectivityIssues = operationalIssues.filter(isConnectivityVerificationIssue);
      if (verificationMode === "warn-on-connectivity" && connectivityIssues.length === operationalIssues.length) {
        verificationWarnings.push(
          `Live verification could not complete because device connectivity is still failing: ${connectivityIssues.slice(0, 8).join("; ")}`,
        );
      } else {
        throw new Error(`Widget generator failed live verification: ${operationalIssues.slice(0, 8).join("; ")}`);
      }
    }
  }

  const slug = targetWidget?.slug ?? slugifyWidgetName(parsed.name);
  const existing = targetWidget ?? stateStore.getDeviceWidgetBySlug(input.deviceId, slug);
  const now = new Date().toISOString();
  const nextControls = parsed.controls as DeviceWidget["controls"];

  const widget = stateStore.upsertDeviceWidget({
    id: existing?.id ?? `widget-${randomUUID()}`,
    deviceId: input.deviceId,
    slug,
    name: parsed.name.trim(),
    description: parsed.description.trim(),
    status: "active",
    html: sanitizeHtml(parsed.html),
    css: sanitizeCss(parsed.css),
    js: sanitizeJs(parsed.js),
    capabilities: parsed.capabilities,
    controls: nextControls,
    sourcePrompt: input.prompt,
    createdBy: input.actor ?? "steward",
    revision: existing?.revision ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  if (!stateStore.getDeviceWidgetRuntimeState(widget.id)) {
    stateStore.upsertDeviceWidgetRuntimeState({
      widgetId: widget.id,
      deviceId: widget.deviceId,
      stateJson: {},
      updatedAt: now,
    });
  }

  return {
    widget,
    updatedExisting: Boolean(existing),
    summary: parsed.summary.trim(),
    warnings: verificationWarnings,
  };
}
