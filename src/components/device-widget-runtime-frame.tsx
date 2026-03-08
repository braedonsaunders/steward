"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Maximize2, Minimize2, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { withClientApiToken } from "@/lib/auth/client-token";
import type {
  DeviceWidget,
  DeviceWidgetControlResult,
  DeviceWidgetOperationRun,
  DeviceWidgetRuntimeState,
  WidgetOperationResult,
} from "@/lib/state/types";
import type { DeviceWidgetContext } from "@/lib/widgets/context";
import { cn } from "@/lib/utils";

type WidgetBridgeRequest =
  | { method: "getContext"; params?: undefined }
  | { method: "refreshContext"; params?: undefined }
  | { method: "getControls"; params?: undefined }
  | { method: "getOperations"; params?: { scope?: "widget" | "device"; limit?: number } }
  | { method: "getState"; params?: undefined }
  | { method: "setState"; params: { state: Record<string, unknown> } }
  | { method: "invokeControl"; params: { controlId: string; input?: Record<string, unknown> } }
  | { method: "invokeControlDetailed"; params: { controlId: string; input?: Record<string, unknown> } }
  | { method: "runOperation"; params: Record<string, unknown> }
  | { method: "runOperationDetailed"; params: Record<string, unknown> };

type WidgetFrameLayoutMode = "content" | "scroll";

export interface DeviceWidgetRuntimeFrameProps {
  deviceId: string;
  widget: DeviceWidget;
  active: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  showFullscreenButton?: boolean;
  maxFrameHeight?: number;
  fillAvailableHeight?: boolean;
  showRuntimeBadges?: boolean;
  className?: string;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function buildWidgetDocument(args: {
  widget: DeviceWidget;
  context: DeviceWidgetContext;
  state: Record<string, unknown>;
}): string {
  const bootstrap = serializeForScript({
    context: args.context,
    state: args.state,
    capabilities: args.widget.capabilities,
    controls: args.widget.controls,
  });

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'" />',
    "<style>",
    ":root { color-scheme: light dark; }",
    "html, body { margin: 0; padding: 0; width: 100%; height: 100%; min-width: 100%; min-height: 100%; background: transparent; overflow: hidden; }",
    "body { display: flex; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    "#steward-widget-root { display: flex; flex: 1 1 auto; min-width: 0; min-height: 100%; height: 100%; width: 100%; box-sizing: border-box; overflow: hidden; }",
    "#steward-widget-surface { display: flex; flex: 1 1 auto; min-width: 0; min-height: 100%; width: 100%; flex-direction: column; align-items: stretch; justify-content: stretch; }",
    "#steward-widget-root, #steward-widget-root * { box-sizing: border-box; }",
    args.widget.css,
    "#steward-widget-surface { display: flex !important; flex: 1 1 auto !important; min-width: 0 !important; min-height: 100% !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }",
    "#steward-widget-surface > * { flex: 1 1 auto !important; min-width: 0 !important; min-height: 100% !important; width: 100% !important; height: 100% !important; max-width: none !important; }",
    "</style>",
    "</head>",
    "<body>",
    `<div id="steward-widget-root"><div id="steward-widget-surface">${args.widget.html}</div></div>`,
    "<script>",
    escapeInlineScript(`
      (() => {
        const bootstrap = ${bootstrap};
        const listeners = new Set();
        const pending = new Map();
        let requestCounter = 0;
        let context = bootstrap.context;
        let persistedState = bootstrap.state;
        const capabilities = Array.isArray(bootstrap.capabilities) ? bootstrap.capabilities : [];
        const controls = Array.isArray(bootstrap.controls) ? bootstrap.controls : [];

        const postToHost = (payload) => {
          window.parent.postMessage({ __stewardWidget: true, direction: "widget-to-host", ...payload }, "*");
        };

        const requestFromHost = (method, params) => {
          const id = \`widget-request-\${++requestCounter}\`;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            postToHost({ type: "request", id, method, params });
          });
        };

        const notifyContextListeners = () => {
          for (const listener of Array.from(listeners)) {
            try {
              listener(context);
            } catch (error) {
              console.error(error);
            }
          }
        };

        const stretchSurface = () => {
          const surface = document.getElementById("steward-widget-surface");
          if (!(surface instanceof HTMLElement)) {
            return;
          }
          Object.assign(surface.style, {
            display: "flex",
            flex: "1 1 auto",
            width: "100%",
            height: "100%",
            minWidth: "0",
            minHeight: "100%",
            overflow: "hidden",
          });
          for (const child of Array.from(surface.children)) {
            if (!(child instanceof HTMLElement)) {
              continue;
            }
            Object.assign(child.style, {
              flex: "1 1 auto",
              width: "100%",
              height: "100%",
              minWidth: "0",
              minHeight: "100%",
              maxWidth: "none",
            });
          }
        };

        const scheduleResize = () => {
          window.requestAnimationFrame(() => {
            const body = document.body;
            const doc = document.documentElement;
            const height = Math.max(
              body ? body.scrollHeight : 0,
              doc ? doc.scrollHeight : 0,
              body ? body.offsetHeight : 0,
              doc ? doc.offsetHeight : 0,
              320,
            );
            postToHost({ type: "resize", height });
          });
        };

        const normalizeMqttMessages = (result) => {
          const details = result && typeof result === "object" && result.details && typeof result.details === "object"
            ? result.details
            : null;
          const messages = details && Array.isArray(details.messages) ? details.messages : [];
          return messages
            .filter((message) => message && typeof message === "object")
            .map((message) => {
              const payload = typeof message.payload === "string" ? message.payload : "";
              let json = null;
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
        };

        const normalizeHttpResponse = (result) => {
          const details = result && typeof result === "object" && result.details && typeof result.details === "object"
            ? result.details
            : null;
          const responseBody = details && typeof details.responseBody === "string"
            ? details.responseBody
            : "";
          const responseJson = details && Object.prototype.hasOwnProperty.call(details, "responseJson")
            ? details.responseJson
            : (() => {
              if (!responseBody) {
                return null;
              }
              const trimmed = responseBody.trim();
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
            body: responseBody,
            json: responseJson,
            statusCode: details && typeof details.statusCode === "number" ? details.statusCode : null,
            url: details && typeof details.url === "string" ? details.url : "",
          };
        };

        const toMqttOperation = (request) => {
          const source = request && typeof request === "object" ? request : {};
          const {
            mode,
            timeoutMs,
            args,
            expectedSemanticTarget,
            ...brokerRequest
          } = source;
          const publishMessages = Array.isArray(brokerRequest.publishMessages) ? brokerRequest.publishMessages : [];
          return {
            mode: mode === "mutate" || mode === "read"
              ? mode
              : (publishMessages.length > 0 ? "mutate" : "read"),
            kind: "mqtt.message",
            adapterId: "mqtt",
            timeoutMs: typeof timeoutMs === "number" ? timeoutMs : 10_000,
            brokerRequest: {
              protocol: "mqtt",
              ...brokerRequest,
            },
            ...(args && typeof args === "object" ? { args } : {}),
            ...(typeof expectedSemanticTarget === "string" && expectedSemanticTarget.trim().length > 0
              ? { expectedSemanticTarget }
              : {}),
          };
        };

        window.addEventListener("message", (event) => {
          const data = event.data;
          if (!data || data.__stewardWidget !== true || data.direction !== "host-to-widget") {
            return;
          }

          if (data.type === "response" && typeof data.id === "string") {
            const pendingRequest = pending.get(data.id);
            if (!pendingRequest) {
              return;
            }
            pending.delete(data.id);
            if (data.ok === false) {
              const error = new Error(typeof data.error === "string" ? data.error : "Widget host request failed.");
              if (typeof data.errorCode === "string") {
                Object.defineProperty(error, "code", {
                  value: data.errorCode,
                  enumerable: false,
                  configurable: true,
                });
              }
              if (data.result && typeof data.result === "object") {
                Object.defineProperty(error, "result", {
                  value: data.result,
                  enumerable: false,
                  configurable: true,
                });
              }
              pendingRequest.reject(error);
            } else {
              pendingRequest.resolve(data.result);
            }
            return;
          }

          if (data.type === "context-update") {
            context = data.context;
            notifyContextListeners();
            scheduleResize();
          }
        });

        const api = {
          getContext() {
            return Promise.resolve(context);
          },
          async refreshContext() {
            const next = await requestFromHost("refreshContext");
            context = next;
            notifyContextListeners();
            scheduleResize();
            return context;
          },
          getControls() {
            return requestFromHost("getControls");
          },
          getOperations(options) {
            return requestFromHost("getOperations", options || {});
          },
          onContext(listener) {
            if (typeof listener !== "function") {
              return () => {};
            }
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async getState() {
            if (!capabilities.includes("state")) {
              return persistedState;
            }
            persistedState = await requestFromHost("getState");
            return persistedState;
          },
          async setState(nextState) {
            if (!capabilities.includes("state")) {
              throw new Error("This widget does not have the state capability.");
            }
            persistedState = await requestFromHost("setState", { state: nextState });
            return persistedState;
          },
          async runOperation(operation) {
            if (!capabilities.includes("device-control")) {
              throw new Error("This widget does not have the device-control capability.");
            }
            return requestFromHost("runOperation", operation);
          },
          async runOperationDetailed(operation) {
            if (!capabilities.includes("device-control")) {
              throw new Error("This widget does not have the device-control capability.");
            }
            return requestFromHost("runOperationDetailed", operation);
          },
          buildMqttOperation(request) {
            return toMqttOperation(request);
          },
          async runMqtt(request) {
            if (!capabilities.includes("device-control")) {
              throw new Error("This widget does not have the device-control capability.");
            }
            return requestFromHost("runOperationDetailed", toMqttOperation(request));
          },
          async invokeControl(controlId, input) {
            if (!capabilities.includes("device-control")) {
              throw new Error("This widget does not have the device-control capability.");
            }
            return requestFromHost("invokeControl", { controlId, input });
          },
          async invokeControlDetailed(controlId, input) {
            if (!capabilities.includes("device-control")) {
              throw new Error("This widget does not have the device-control capability.");
            }
            return requestFromHost("invokeControlDetailed", { controlId, input });
          },
          getMqttMessages(result) {
            return normalizeMqttMessages(result);
          },
          getHttpResponse(result) {
            return normalizeHttpResponse(result);
          },
          getHttpJson(result) {
            return normalizeHttpResponse(result).json;
          },
          setLayout(options) {
            const nextMode = options && options.mode === "scroll" ? "scroll" : "content";
            postToHost({ type: "layout", mode: nextMode });
            scheduleResize();
            return { mode: nextMode };
          },
          setStatus(text) {
            postToHost({ type: "status", text: typeof text === "string" ? text : String(text ?? "") });
          },
          ready() {
            postToHost({ type: "ready" });
          },
        };

        Object.defineProperty(api, "context", {
          get() {
            return context;
          },
        });

        Object.defineProperty(api, "controls", {
          get() {
            return controls;
          },
        });

        window.StewardWidget = api;

        window.addEventListener("error", (event) => {
          postToHost({
            type: "runtime-error",
            message: event.message || "Widget runtime error",
          });
        });

        window.addEventListener("unhandledrejection", (event) => {
          const reason = event.reason;
          postToHost({
            type: "runtime-error",
            message: reason instanceof Error ? reason.message : String(reason ?? "Unhandled promise rejection"),
          });
        });

        const observer = new ResizeObserver(() => scheduleResize());
        observer.observe(document.documentElement);
        observer.observe(document.body);
        const surfaceObserver = new MutationObserver(() => stretchSurface());
        const surface = document.getElementById("steward-widget-surface");
        if (surface) {
          surfaceObserver.observe(surface, { childList: true });
        }

        window.addEventListener("load", () => {
          stretchSurface();
          api.ready();
          scheduleResize();
        });

        stretchSurface();
        scheduleResize();
      })();
    `),
    "</script>",
    "<script>",
    escapeInlineScript(args.widget.js),
    "</script>",
    "</body>",
    "</html>",
  ].join("");
}

function createWidgetOperationError(result: WidgetOperationResult, fallbackMessage?: string): Error {
  const error = new Error(
    fallbackMessage
      ?? result.summary
      ?? result.output
      ?? "Widget operation failed.",
  );
  Object.defineProperty(error, "code", {
    value: `widget-operation:${result.status}`,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(error, "result", {
    value: result,
    enumerable: false,
    configurable: true,
  });
  return error;
}

function createWidgetControlError(result: DeviceWidgetControlResult, fallbackMessage?: string): Error {
  const error = new Error(
    fallbackMessage
      ?? result.summary
      ?? "Widget control failed.",
  );
  Object.defineProperty(error, "code", {
    value: `widget-control:${result.status}`,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(error, "result", {
    value: result,
    enumerable: false,
    configurable: true,
  });
  return error;
}

export function DeviceWidgetRuntimeFrame({
  deviceId,
  widget,
  active,
  fullscreen,
  onToggleFullscreen,
  showFullscreenButton = true,
  maxFrameHeight = 2_200,
  fillAvailableHeight = false,
  showRuntimeBadges = true,
  className,
}: DeviceWidgetRuntimeFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [resolvedWidget, setResolvedWidget] = useState(widget);
  const [widgetLoading, setWidgetLoading] = useState(false);
  const [context, setContext] = useState<DeviceWidgetContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [runtimeState, setRuntimeState] = useState<Record<string, unknown>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [frameHeight, setFrameHeight] = useState(640);
  const [frameLayoutMode, setFrameLayoutMode] = useState<WidgetFrameLayoutMode>("content");
  const [frameStatus, setFrameStatus] = useState("Ready");
  const [frameError, setFrameError] = useState<string | null>(null);
  const [bootSnapshot, setBootSnapshot] = useState<{ context: DeviceWidgetContext; state: Record<string, unknown> } | null>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const loading = contextLoading || runtimeLoading || widgetLoading;
  const runtimeActive = active && isInViewport && isDocumentVisible && !loading && Boolean(context);

  useEffect(() => {
    if (typeof document !== "undefined") {
      setIsDocumentVisible(!document.hidden);
    }
    const handleVisibilityChange = () => {
      setIsDocumentVisible(typeof document === "undefined" ? true : !document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setIsInViewport(true);
      return;
    }
    const target = containerRef.current;
    if (!target) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setIsInViewport(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.2));
      },
      {
        root: null,
        threshold: [0, 0.2, 0.5, 1],
      },
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, []);

  const loadContext = useCallback(async (): Promise<DeviceWidgetContext | null> => {
    setContextLoading(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/widgets/context`,
        withClientApiToken(),
      );
      const data = (await response.json()) as { context?: DeviceWidgetContext; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to load widget context.");
      }
      const nextContext = data.context ?? null;
      setContext(nextContext);
      return nextContext;
    } finally {
      setContextLoading(false);
    }
  }, [deviceId]);

  const loadRuntimeState = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/widgets/${widget.id}/state`,
        withClientApiToken(),
      );
      const data = (await response.json()) as { state?: DeviceWidgetRuntimeState; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to load widget state.");
      }
      setRuntimeState(data.state?.stateJson ?? {});
    } finally {
      setRuntimeLoading(false);
    }
  }, [deviceId, widget.id]);

  const loadWidgetSource = useCallback(async (): Promise<DeviceWidget> => {
    const needsFetch = widget.html.length === 0 && widget.css.length === 0 && widget.js.length === 0;
    if (!needsFetch) {
      setResolvedWidget(widget);
      setWidgetLoading(false);
      return widget;
    }

    setWidgetLoading(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/widgets/${widget.id}`,
        withClientApiToken(),
      );
      const data = (await response.json()) as { widget?: DeviceWidget; error?: string };
      if (!response.ok || !data.widget) {
        throw new Error(data.error ?? "Failed to load widget source.");
      }
      setResolvedWidget(data.widget);
      return data.widget;
    } finally {
      setWidgetLoading(false);
    }
  }, [deviceId, widget]);

  useEffect(() => {
    const needsWidgetSource = widget.html.length === 0 && widget.css.length === 0 && widget.js.length === 0;
    setResolvedWidget(widget);
    setWidgetLoading(needsWidgetSource);
    setContext(null);
    setRuntimeState({});
    setContextLoading(true);
    setRuntimeLoading(true);
    setFrameStatus("Ready");
    setFrameError(null);
    setFrameHeight(640);
    setFrameLayoutMode("content");
    setBootSnapshot(null);
    void Promise.all([
      loadContext(),
      loadRuntimeState(),
      loadWidgetSource(),
    ]).catch((error) => {
      setFrameError(error instanceof Error ? error.message : "Failed to load widget runtime.");
    });
  }, [deviceId, widget, loadContext, loadRuntimeState, loadWidgetSource]);

  useEffect(() => {
    if (!loading && context && !bootSnapshot) {
      setBootSnapshot({
        context,
        state: runtimeState,
      });
    }
  }, [bootSnapshot, context, loading, runtimeState]);

  const respondToWidget = useCallback((message: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({
      __stewardWidget: true,
      direction: "host-to-widget",
      ...message,
    }, "*");
  }, []);

  const loadOperationRuns = useCallback(async (
    scope: "widget" | "device" = "widget",
    limit = 20,
  ): Promise<DeviceWidgetOperationRun[]> => {
    const response = await fetch(
      `/api/devices/${deviceId}/widgets/${widget.id}/runs?scope=${scope}&limit=${Math.max(1, Math.min(limit, 100))}`,
      withClientApiToken(),
    );
    const payload = (await response.json()) as { runs?: DeviceWidgetOperationRun[]; error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Failed to load widget operation history.");
    }
    return payload.runs ?? [];
  }, [deviceId, widget.id]);

  const postWidgetOperation = useCallback(async (
    operation: Record<string, unknown>,
  ): Promise<WidgetOperationResult> => {
    const response = await fetch(
      `/api/devices/${deviceId}/widgets/${widget.id}/operation`,
      withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation,
        }),
      }),
    );
    const payload = (await response.json()) as WidgetOperationResult & { error?: string };
    if (
      typeof payload !== "object"
      || payload === null
      || typeof payload.status !== "string"
      || typeof payload.summary !== "string"
    ) {
      throw new Error(payload.error ?? "Widget operation failed.");
    }
    return payload;
  }, [deviceId, widget.id]);

  const postWidgetControl = useCallback(async (
    controlId: string,
    input: Record<string, unknown> | undefined,
  ): Promise<DeviceWidgetControlResult> => {
    const response = await fetch(
      `/api/devices/${deviceId}/widgets/${widget.id}/controls`,
      withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controlId,
          input,
        }),
      }),
    );
    const payload = (await response.json()) as DeviceWidgetControlResult & { error?: string };
    if (
      typeof payload !== "object"
      || payload === null
      || typeof payload.status !== "string"
      || typeof payload.summary !== "string"
    ) {
      throw new Error(payload.error ?? "Widget control failed.");
    }
    return payload;
  }, [deviceId, widget.id]);

  useEffect(() => {
    if (!runtimeActive || !context) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__stewardWidget !== true || data.direction !== "widget-to-host") {
        return;
      }

      const type = data.type;
      if (type === "resize") {
        if (frameLayoutMode === "scroll") {
          return;
        }
        const rawHeight = Number(data.height);
        if (Number.isFinite(rawHeight)) {
          setFrameHeight(Math.max(320, Math.min(maxFrameHeight, Math.ceil(rawHeight))));
        }
        return;
      }

      if (type === "layout") {
        setFrameLayoutMode(data.mode === "scroll" ? "scroll" : "content");
        return;
      }

      if (type === "status") {
        setFrameStatus(typeof data.text === "string" && data.text.trim().length > 0 ? data.text.trim() : "Ready");
        return;
      }

      if (type === "runtime-error") {
        setFrameError(typeof data.message === "string" ? data.message : "Widget runtime error");
        return;
      }

      if (type === "ready") {
        respondToWidget({ type: "context-update", context });
        return;
      }

      if (type !== "request" || typeof data.id !== "string" || typeof data.method !== "string") {
        return;
      }

      const requestId = data.id;
      const method = data.method as WidgetBridgeRequest["method"];
      const params = (data.params ?? undefined) as WidgetBridgeRequest["params"];

      const reply = async () => {
        try {
          if (method === "getContext") {
            respondToWidget({ type: "response", id: requestId, ok: true, result: context });
            return;
          }

          if (method === "refreshContext") {
            const nextContext = await loadContext();
            if (!nextContext) {
              throw new Error("Device widget context is unavailable.");
            }
            respondToWidget({ type: "context-update", context: nextContext });
            respondToWidget({ type: "response", id: requestId, ok: true, result: nextContext });
            return;
          }

          if (method === "getControls") {
            respondToWidget({ type: "response", id: requestId, ok: true, result: resolvedWidget.controls ?? [] });
            return;
          }

          if (method === "getOperations") {
            const options = (params ?? {}) as { scope?: "widget" | "device"; limit?: number };
            const runs = await loadOperationRuns(
              options.scope === "device" ? "device" : "widget",
              typeof options.limit === "number" ? options.limit : 20,
            );
            respondToWidget({ type: "response", id: requestId, ok: true, result: runs });
            return;
          }

          if (method === "getState") {
            respondToWidget({ type: "response", id: requestId, ok: true, result: runtimeState });
            return;
          }

          if (method === "setState") {
            const nextState = (params && "state" in params ? params.state : {}) as Record<string, unknown>;
            const response = await fetch(
              `/api/devices/${deviceId}/widgets/${widget.id}/state`,
              withClientApiToken({
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ state: nextState }),
              }),
            );
            const payload = (await response.json()) as { state?: DeviceWidgetRuntimeState; error?: string };
            if (!response.ok) {
              throw new Error(payload.error ?? "Failed to persist widget state.");
            }
            const savedState = payload.state?.stateJson ?? {};
            setRuntimeState(savedState);
            respondToWidget({ type: "response", id: requestId, ok: true, result: savedState });
            return;
          }

          if (method === "invokeControl" || method === "invokeControlDetailed") {
            const controlParams = (params ?? {}) as { controlId?: string; input?: Record<string, unknown> };
            if (typeof controlParams.controlId !== "string" || controlParams.controlId.trim().length === 0) {
              throw new Error("controlId is required.");
            }
            const payload = await postWidgetControl(controlParams.controlId, controlParams.input);
            if (!payload.ok && method === "invokeControl") {
              throw createWidgetControlError(payload);
            }
            respondToWidget({ type: "response", id: requestId, ok: true, result: payload });
            return;
          }

          if (method === "runOperation" || method === "runOperationDetailed") {
            const operation = (params ?? {}) as Record<string, unknown>;
            const payload = await postWidgetOperation(operation);
            if (!payload.ok && method === "runOperation") {
              throw createWidgetOperationError(payload);
            }
            respondToWidget({ type: "response", id: requestId, ok: true, result: payload });
            return;
          }

          throw new Error(`Unsupported widget bridge method: ${String(method)}`);
        } catch (error) {
          const errorWithCode = error as Error & { code?: unknown; result?: unknown };
          respondToWidget({
            type: "response",
            id: requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof Error && typeof errorWithCode.code === "string"
              ? errorWithCode.code
              : undefined,
            result: error instanceof Error && typeof errorWithCode.result !== "undefined"
              ? errorWithCode.result
              : undefined,
          });
        }
      };

      void reply();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [
    context,
    deviceId,
    frameLayoutMode,
    loadContext,
    loadOperationRuns,
    maxFrameHeight,
    postWidgetControl,
    postWidgetOperation,
    respondToWidget,
    resolvedWidget.controls,
    runtimeActive,
    runtimeState,
    widget.id,
  ]);

  useEffect(() => {
    if (!runtimeActive || !context) {
      return;
    }
    respondToWidget({ type: "context-update", context });
  }, [runtimeActive, context, respondToWidget]);

  const documentHtml = useMemo(
    () => bootSnapshot
      ? buildWidgetDocument({
        widget: resolvedWidget,
        context: bootSnapshot.context,
        state: bootSnapshot.state,
      })
      : "",
    [bootSnapshot, resolvedWidget],
  );

  const iframeHeight = fillAvailableHeight
    ? "100%"
    : frameLayoutMode === "scroll"
    ? (fullscreen ? "100%" : "clamp(480px, 75vh, 880px)")
    : `${frameHeight}px`;

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col",
        showRuntimeBadges ? "gap-3" : "h-full min-h-0",
        fullscreen && "h-full",
        className,
      )}
    >
      {showRuntimeBadges && !fullscreen && !loading && bootSnapshot ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="gap-1">
            <Activity className="size-3" />
            {frameStatus}
          </Badge>
          {!runtimeActive && <Badge variant="outline">Paused (off-screen)</Badge>}
          <Badge variant="outline">rev {resolvedWidget.revision}</Badge>
          <Badge variant="outline">{resolvedWidget.controls.length} control{resolvedWidget.controls.length === 1 ? "" : "s"}</Badge>
          {resolvedWidget.capabilities.map((capability) => (
            <Badge key={capability} variant="outline" className="capitalize">
              {capability.replace(/-/g, " ")}
            </Badge>
          ))}
        </div>
      ) : null}

      {frameError && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p>{frameError}</p>
          </CardContent>
        </Card>
      )}

      <div
        className={cn(
          "group/widget-canvas relative",
          (fullscreen || fillAvailableHeight) && "h-full min-h-0 flex-1",
        )}
      >
        {showFullscreenButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={fullscreen ? "Exit widget fullscreen" : "Enter widget fullscreen"}
            className={cn(
              "absolute right-3 top-3 z-10 h-8 w-8 rounded-full border border-border/60 bg-background/72 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity duration-150",
              "opacity-100 hover:bg-background hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover/widget-canvas:opacity-100 md:group-focus-within/widget-canvas:opacity-100",
            )}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        )}

        {loading || !bootSnapshot ? (
          <Skeleton
            className={cn(
              "w-full",
              fillAvailableHeight ? "h-full min-h-[220px] rounded-none" : "h-[480px] rounded-2xl",
            )}
          />
        ) : runtimeActive ? (
          <iframe
            ref={iframeRef}
            title={resolvedWidget.name}
            sandbox="allow-scripts"
            srcDoc={documentHtml}
            className={cn(
              "block w-full bg-background",
              fillAvailableHeight ? "h-full min-h-0 rounded-none border-0" : "min-h-[320px] rounded-2xl border",
              fullscreen && "h-full min-h-full rounded-[24px]",
            )}
            style={{ height: iframeHeight }}
          />
        ) : (
          <Card>
            <CardContent className="flex min-h-[320px] items-center justify-center p-4 text-sm text-muted-foreground">
              Widget runtime is paused while this panel is off-screen.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
