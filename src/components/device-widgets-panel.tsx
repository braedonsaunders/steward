"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, LayoutGrid, Maximize2, Minimize2, RefreshCw, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { withClientApiToken } from "@/lib/auth/client-token";
import type {
  DeviceWidget,
  DeviceWidgetOperationRun,
  DeviceWidgetRuntimeState,
  WidgetOperationResult,
} from "@/lib/state/types";
import type { DeviceWidgetContext } from "@/lib/widgets/context";
import { cn } from "@/lib/utils";

interface DeviceWidgetsPanelProps {
  deviceId: string;
  active?: boolean;
  className?: string;
}

type WidgetBridgeRequest =
  | { method: "getContext"; params?: undefined }
  | { method: "refreshContext"; params?: undefined }
  | { method: "getOperations"; params?: { scope?: "widget" | "device"; limit?: number } }
  | { method: "getState"; params?: undefined }
  | { method: "setState"; params: { state: Record<string, unknown> } }
  | { method: "runOperation"; params: Record<string, unknown> }
  | { method: "runOperationDetailed"; params: Record<string, unknown> };

type WidgetFrameLayoutMode = "content" | "scroll";

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
  });

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'" />',
    "<style>",
    ":root { color-scheme: light dark; }",
    "html, body { margin: 0; padding: 0; height: 100%; min-height: 100%; background: transparent; }",
    "body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }",
    "#steward-widget-root { min-height: 100%; height: 100%; box-sizing: border-box; }",
    args.widget.css,
    "</style>",
    "</head>",
    "<body>",
    `<div id="steward-widget-root">${args.widget.html}</div>`,
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

        window.addEventListener("load", () => {
          api.ready();
          scheduleResize();
        });

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

function WidgetRuntimeFrame({
  deviceId,
  widget,
  context,
  active,
  fullscreen,
  onToggleFullscreen,
  onContextRefresh,
  maxFrameHeight = 2_200,
}: {
  deviceId: string;
  widget: DeviceWidget;
  context: DeviceWidgetContext;
  active: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onContextRefresh: () => Promise<DeviceWidgetContext | null>;
  maxFrameHeight?: number;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [runtimeState, setRuntimeState] = useState<Record<string, unknown>>({});
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [frameHeight, setFrameHeight] = useState(640);
  const [frameLayoutMode, setFrameLayoutMode] = useState<WidgetFrameLayoutMode>("content");
  const [frameStatus, setFrameStatus] = useState("Ready");
  const [frameError, setFrameError] = useState<string | null>(null);
  const [bootSnapshot, setBootSnapshot] = useState<{ context: DeviceWidgetContext; state: Record<string, unknown> } | null>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(true);
  const runtimeActive = active && isInViewport && isDocumentVisible;

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

  const loadRuntimeState = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const response = await fetch(
        `/api/devices/${deviceId}/widgets/${widget.id}/state`,
        withClientApiToken(),
      );
      const data = (await response.json()) as { state?: DeviceWidgetRuntimeState };
      setRuntimeState(data.state?.stateJson ?? {});
    } catch (error) {
      setFrameError(error instanceof Error ? error.message : "Failed to load widget state.");
    } finally {
      setRuntimeLoading(false);
    }
  }, [deviceId, widget.id]);

  useEffect(() => {
    void loadRuntimeState();
  }, [loadRuntimeState]);

  useEffect(() => {
    setFrameStatus("Ready");
    setFrameError(null);
    setFrameHeight(640);
    setFrameLayoutMode("content");
    setBootSnapshot(null);
  }, [widget.id, widget.revision]);

  useEffect(() => {
    if (!runtimeLoading && !bootSnapshot) {
      setBootSnapshot({
        context,
        state: runtimeState,
      });
    }
  }, [bootSnapshot, context, runtimeLoading, runtimeState]);

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

  useEffect(() => {
    if (!runtimeActive) {
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
            const nextContext = await onContextRefresh();
            if (!nextContext) {
              throw new Error("Device widget context is unavailable.");
            }
            respondToWidget({ type: "context-update", context: nextContext });
            respondToWidget({ type: "response", id: requestId, ok: true, result: nextContext });
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
    runtimeActive,
    context,
    deviceId,
    loadOperationRuns,
    onContextRefresh,
    postWidgetOperation,
    maxFrameHeight,
    frameLayoutMode,
    respondToWidget,
    runtimeState,
    widget.id,
  ]);

  useEffect(() => {
    if (!runtimeActive || runtimeLoading) {
      return;
    }
    respondToWidget({ type: "context-update", context });
  }, [runtimeActive, context, respondToWidget, runtimeLoading]);

  const documentHtml = useMemo(
    () => bootSnapshot
      ? buildWidgetDocument({
        widget,
        context: bootSnapshot.context,
        state: bootSnapshot.state,
      })
      : "",
    [bootSnapshot, widget],
  );

  const iframeHeight = frameLayoutMode === "scroll"
    ? (fullscreen ? "100%" : "clamp(480px, 75vh, 880px)")
    : `${frameHeight}px`;

  return (
    <div ref={containerRef} className={cn("space-y-3", fullscreen && "h-full")}>
      {!fullscreen && !runtimeLoading && bootSnapshot ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="gap-1">
              <Activity className="size-3" />
              {frameStatus}
            </Badge>
            {!runtimeActive && <Badge variant="outline">Paused (off-screen)</Badge>}
            <Badge variant="outline">rev {widget.revision}</Badge>
            {widget.capabilities.map((capability) => (
              <Badge key={capability} variant="outline" className="capitalize">
                {capability.replace(/-/g, " ")}
              </Badge>
            ))}
          </div>
        </>
      ) : null}

      {frameError && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p>{frameError}</p>
          </CardContent>
        </Card>
      )}

      <div className={cn("group/widget-canvas relative", fullscreen && "h-full")}>
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

        {runtimeLoading || !bootSnapshot ? (
          <Skeleton className="h-[480px] w-full rounded-2xl" />
        ) : runtimeActive ? (
          <iframe
            ref={iframeRef}
            title={widget.name}
            sandbox="allow-scripts"
            srcDoc={documentHtml}
            className={cn(
              "block min-h-[320px] w-full rounded-2xl border bg-background",
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

function WidgetSurface({
  deviceId,
  widget,
  context,
  active,
  fullscreen,
  onToggleFullscreen,
  onContextRefresh,
}: {
  deviceId: string;
  widget: DeviceWidget;
  context: DeviceWidgetContext;
  active: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onContextRefresh: () => Promise<DeviceWidgetContext | null>;
}) {
  return (
    <Card
      className={cn(
        "min-h-0 min-w-0 overflow-hidden",
        fullscreen && "flex h-full flex-col rounded-[28px] border-border/70 bg-background/95 shadow-2xl",
      )}
    >
      {!fullscreen && (
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">{widget.name}</CardTitle>
              {widget.description && (
                <CardDescription className="mt-1">{widget.description}</CardDescription>
              )}
            </div>
            <Badge variant="outline" className="capitalize">{widget.slug}</Badge>
          </div>
        </CardHeader>
      )}
      <CardContent className={cn("min-h-0 min-w-0 overflow-auto", fullscreen && "flex-1 overflow-hidden p-3 md:p-4")}>
        <WidgetRuntimeFrame
          deviceId={deviceId}
          widget={widget}
          context={context}
          active={active}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          onContextRefresh={onContextRefresh}
          maxFrameHeight={fullscreen ? 4_000 : 2_000}
        />
      </CardContent>
    </Card>
  );
}

export function DeviceWidgetsPanel({ deviceId, active = false, className }: DeviceWidgetsPanelProps) {
  const [widgets, setWidgets] = useState<DeviceWidget[]>([]);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [context, setContext] = useState<DeviceWidgetContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setWidgets([]);
    setSelectedWidgetId(null);
    setContext(null);
    setError(null);
    setHasLoaded(false);
    setLoading(true);
    setFullscreen(false);
  }, [deviceId]);

  useEffect(() => {
    if (!active) {
      setFullscreen(false);
    }
  }, [active]);

  useEffect(() => {
    if (!fullscreen || typeof document === "undefined") {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fullscreen]);

  const loadContext = useCallback(async (): Promise<DeviceWidgetContext | null> => {
    const response = await fetch(
      `/api/devices/${deviceId}/widgets/context`,
      withClientApiToken(),
    );
    const data = (await response.json()) as { context?: DeviceWidgetContext; error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to load widget context.");
    }
    setContext(data.context ?? null);
    return data.context ?? null;
  }, [deviceId]);

  const loadWidgets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [widgetsResponse] = await Promise.all([
        fetch(`/api/devices/${deviceId}/widgets`, withClientApiToken()),
        loadContext(),
      ]);
      const widgetsPayload = (await widgetsResponse.json()) as { widgets?: DeviceWidget[]; error?: string };
      if (!widgetsResponse.ok) {
        throw new Error(widgetsPayload.error ?? "Failed to load widgets.");
      }
      const nextWidgets = widgetsPayload.widgets ?? [];
      setWidgets(nextWidgets);
      setSelectedWidgetId((current) => {
        if (current && nextWidgets.some((widget) => widget.id === current)) {
          return current;
        }
        return nextWidgets[0]?.id ?? null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setHasLoaded(true);
      setLoading(false);
    }
  }, [deviceId, loadContext]);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void loadWidgets();
  }, [active, hasLoaded, loadWidgets]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadWidgets();
    } finally {
      setRefreshing(false);
    }
  }, [loadWidgets]);

  const deleteSelectedWidget = useCallback(async () => {
    try {
      const selected = widgets.find((widget) => widget.id === selectedWidgetId);
      if (!selected) {
        return;
      }
      if (!window.confirm(`Delete widget "${selected.name}"?`)) {
        return;
      }

      const response = await fetch(
        `/api/devices/${deviceId}/widgets/${selected.id}`,
        withClientApiToken({ method: "DELETE" }),
      );
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? "Failed to delete widget.");
      }
      await loadWidgets();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [deviceId, loadWidgets, selectedWidgetId, widgets]);

  const selectedWidget = useMemo(
    () => widgets.find((widget) => widget.id === selectedWidgetId) ?? null,
    [selectedWidgetId, widgets],
  );

  if (loading) {
    return (
      <div className={cn("grid min-w-0 gap-4 lg:grid-cols-[300px_1fr]", className)}>
        <Skeleton className="h-[420px] w-full rounded-2xl" />
        <Skeleton className="h-[520px] w-full rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className={cn("border-destructive/50", className)}>
        <CardHeader>
          <CardTitle className="text-destructive">Widget runtime unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!selectedWidget || !context) {
    return (
      <Card className={cn("border-dashed", className)}>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <CardTitle className="text-base">No widgets yet</CardTitle>
          </div>
          <CardDescription>
            Use Chat on this device page to generate persistent widgets backed by the live device context.
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  const widgetSurface = (
    <WidgetSurface
      deviceId={deviceId}
      widget={selectedWidget}
      context={context}
      active={active}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((current) => !current)}
      onContextRefresh={loadContext}
    />
  );

  const fullscreenOverlay = fullscreen && typeof document !== "undefined"
    ? createPortal(
      <div className="fixed inset-y-0 left-0 right-0 z-[60] bg-background/86 backdrop-blur-sm md:left-[var(--steward-sidebar-width)]">
        <div className="flex h-full min-h-0 flex-col p-2 md:p-3 lg:p-4">
          {widgetSurface}
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div
        className={cn(
          "relative grid h-full min-h-0 min-w-0 gap-4 overflow-x-hidden lg:grid-cols-[300px_1fr]",
          className,
        )}
      >
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <CardHeader className="gap-3 pb-3">
            <div className="flex items-center gap-2">
              <LayoutGrid className="size-4 text-primary" />
              <CardTitle className="text-base">Saved Widgets</CardTitle>
              <Badge variant="secondary" className="ml-auto">{widgets.length}</Badge>
            </div>
            <CardDescription>
              Persistent, device-scoped UI surfaces generated in chat and stored with Steward.
            </CardDescription>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void refreshAll()} disabled={refreshing}>
                <RefreshCw className={cn("mr-2 size-3.5", refreshing && "animate-spin")} />
                Refresh
              </Button>
              <Button size="sm" variant="outline" onClick={() => void deleteSelectedWidget()}>
                <Trash2 className="mr-2 size-3.5" />
                Delete
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 min-w-0 flex-1 p-0">
            <ScrollArea className="h-full min-w-0 [&>[data-radix-scroll-area-viewport]]:overflow-x-hidden">
              <div className="space-y-2 p-3 pr-4">
                {widgets.map((widget) => (
                  <button
                    key={widget.id}
                    type="button"
                    onClick={() => setSelectedWidgetId(widget.id)}
                    className={cn(
                      "block w-full min-w-0 max-w-full overflow-hidden rounded-2xl border px-3 py-3 text-left transition-colors",
                      widget.id === selectedWidgetId
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border/70 bg-card hover:border-primary/40 hover:bg-accent/40",
                    )}
                  >
                    <div className="flex min-w-0 flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{widget.name}</p>
                        {widget.description && (
                          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                            {widget.description}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant={widget.status === "active" ? "default" : "outline"}
                        className="shrink-0 capitalize"
                      >
                        {widget.status}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {!fullscreen && widgetSurface}
      </div>
      {fullscreenOverlay}
    </>
  );
}
