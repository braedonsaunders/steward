import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { DeviceWidget, DeviceWidgetOperationRun, LLMProvider } from "@/lib/state/types";
import { buildDeviceWidgetContext } from "@/lib/widgets/context";

const GeneratedWidgetSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().min(1).max(240),
  capabilities: z.array(z.enum(["context", "state", "device-control"])).min(1).max(3),
  html: z.string().min(1).max(24_000),
  css: z.string().max(24_000).default(""),
  js: z.string().min(1).max(48_000),
  summary: z.string().min(1).max(320),
});

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
}

export interface GenerateDeviceWidgetResult {
  widget: DeviceWidget;
  updatedExisting: boolean;
  summary: string;
}

export async function generateAndStoreDeviceWidget(
  input: GenerateDeviceWidgetInput,
): Promise<GenerateDeviceWidgetResult> {
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

  const model = await buildLanguageModel(input.provider, input.model);
  const result = await generateText({
    model,
    temperature: 0.15,
    maxOutputTokens: 7_000,
    system: [
      "You generate persistent device widgets for Steward.",
      "Return JSON only. No markdown. No code fences.",
      "The widget will be stored and rendered in a sandboxed iframe on the device page.",
      "Do not reference external scripts, CDNs, fonts, images, or network APIs directly.",
      "Use only the runtime contract below.",
      "HTML must omit <script>, <style>, <html>, and <body> tags.",
      "JavaScript must be self-contained and robust if data is missing.",
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
      "For HTTP operations, details.responseBody contains the raw response body and details.responseJson contains parsed JSON when the body is valid JSON. Prefer getHttpResponse()/getHttpJson() instead of parsing result.output.",
      "MQTT operation results include details.messages when responses are collected. Prefer window.StewardWidget.getMqttMessages(result) instead of parsing output text.",
      "Operation template interpolation resolves {{host}} automatically and any scalar key provided in operation.args.",
      "Stored device credentials are applied by Steward inside the broker. Never embed credential secrets, usernames, bearer tokens, API keys, or placeholders such as {{apiKey}} in widget code.",
      "If context.credentials includes an http-api credential with auth.appliedBySteward=true, rely on the broker to attach auth automatically.",
      "For http-api auth.mode='path-segment', use the logical API path (for example '/api/groups'); Steward inserts the stored token after auth.pathPrefix automatically.",
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
      "- Windows telemetry over WinRM: { mode: 'read', kind: 'shell.command', adapterId: 'winrm', timeoutMs: 30000, brokerRequest: { protocol: 'winrm', useSsl: true, skipCertChecks: true, authentication: 'basic', command: 'Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory; Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free' } }",
      "- When the Steward host is macOS, prefer Windows PowerShell over SSH when the target exposes SSH. If WinRM is required, it must use HTTPS plus authentication: 'basic'. On Linux, prefer brokerRequest over shell-wrapped pwsh commands.",
      "",
      "Capabilities:",
      "- context: required if widget reads context.",
      "- state: required if widget stores local state.",
      "- device-control: required if widget calls runOperation.",
      "",
      "Return this JSON shape:",
      "{",
      '  "name": "string",',
      '  "description": "string",',
      '  "capabilities": ["context", "state", "device-control"],',
      '  "html": "<div>...</div>",',
      '  "css": "string",',
      '  "js": "string",',
      '  "summary": "one short sentence for the operator"',
      "}",
    ].join("\n"),
    prompt: [
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
    ].join("\n"),
  });

  const parsed = GeneratedWidgetSchema.parse(extractFirstJsonObject(result.text));
  const slug = targetWidget?.slug ?? slugifyWidgetName(parsed.name);
  const existing = targetWidget ?? stateStore.getDeviceWidgetBySlug(input.deviceId, slug);
  const now = new Date().toISOString();

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
  };
}
