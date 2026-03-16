"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, RefreshCw, Sparkles, Trash2 } from "lucide-react";
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
import type { ChatToolWidgetMutation, DeviceWidget } from "@/lib/state/types";
import { cn } from "@/lib/utils";
import { DeviceWidgetRuntimeFrame } from "@/components/device-widget-runtime-frame";

interface DeviceWidgetsPanelProps {
  deviceId: string;
  active?: boolean;
  widgetMutation?: ChatToolWidgetMutation | null;
  className?: string;
}

function WidgetSurface({
  deviceId,
  widget,
  active,
  fullscreen,
  onToggleFullscreen,
}: {
  deviceId: string;
  widget: DeviceWidget;
  active: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <Card
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        fullscreen && "flex h-full flex-col rounded-[28px] border-border/70 bg-background/95 shadow-2xl",
      )}
    >
      {!fullscreen && (
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base">{widget.name}</CardTitle>
              {widget.description && (
                <CardDescription className="mt-1 line-clamp-2">{widget.description}</CardDescription>
              )}
            </div>
            <Badge variant="outline" className="capitalize">{widget.slug}</Badge>
          </div>
        </CardHeader>
      )}
      <CardContent className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden",
        fullscreen ? "p-3 md:p-4" : "p-6 pt-0",
      )}>
        <DeviceWidgetRuntimeFrame
          deviceId={deviceId}
          widget={widget}
          active={active}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          maxFrameHeight={fullscreen ? 4_000 : 2_000}
          fillAvailableHeight
          showRuntimeBadges={false}
          className="h-full w-full flex-1"
        />
      </CardContent>
    </Card>
  );
}

export function DeviceWidgetsPanel({
  deviceId,
  active = false,
  widgetMutation = null,
  className,
}: DeviceWidgetsPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [widgets, setWidgets] = useState<DeviceWidget[]>([]);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(0);

  useEffect(() => {
    setWidgets([]);
    setSelectedWidgetId(null);
    setError(null);
    setHasLoaded(false);
    setLoading(true);
    setRefreshing(false);
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

  useEffect(() => {
    const target = panelRef.current;
    if (!target) {
      return;
    }

    const updateWidth = () => {
      setPanelWidth(Math.round(target.getBoundingClientRect().width));
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(() => updateWidth());
    observer.observe(target);
    return () => observer.disconnect();
  }, [loading]);

  const loadWidgets = useCallback(async (options?: {
    background?: boolean;
    preferredWidgetId?: string | null;
  }) => {
    const background = options?.background ?? false;
    if (!background) {
      setLoading(true);
    }
    setError(null);
    try {
      const widgetsResponse = await fetch(`/api/devices/${deviceId}/widgets`, withClientApiToken());
      const widgetsPayload = (await widgetsResponse.json()) as { widgets?: DeviceWidget[]; error?: string };
      if (!widgetsResponse.ok) {
        throw new Error(widgetsPayload.error ?? "Failed to load widgets.");
      }
      const nextWidgets = widgetsPayload.widgets ?? [];
      const preferredWidgetId = options?.preferredWidgetId ?? null;
      setWidgets(nextWidgets);
      setSelectedWidgetId((current) => {
        if (preferredWidgetId && nextWidgets.some((widget) => widget.id === preferredWidgetId)) {
          return preferredWidgetId;
        }
        if (current && nextWidgets.some((widget) => widget.id === current)) {
          return current;
        }
        return nextWidgets[0]?.id ?? null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setHasLoaded(true);
      if (!background) {
        setLoading(false);
      }
    }
  }, [deviceId]);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void loadWidgets();
  }, [active, hasLoaded, loadWidgets]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadWidgets({ background: hasLoaded });
    } finally {
      setRefreshing(false);
    }
  }, [hasLoaded, loadWidgets]);

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

  useEffect(() => {
    if (!widgetMutation || widgetMutation.deviceId !== deviceId) {
      return;
    }
    if (!active && !hasLoaded) {
      return;
    }

    let cancelled = false;
    setRefreshing(true);
    void loadWidgets({
      background: hasLoaded,
      preferredWidgetId: widgetMutation.action === "deleted" ? null : widgetMutation.widgetId,
    }).finally(() => {
      if (!cancelled) {
        setRefreshing(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [active, deviceId, hasLoaded, loadWidgets, widgetMutation]);

  const selectedWidget = useMemo(
    () => widgets.find((widget) => widget.id === selectedWidgetId) ?? null,
    [selectedWidgetId, widgets],
  );
  const showSplitLayout = panelWidth >= 980;
  const panelGridClass = showSplitLayout
    ? "grid-cols-[280px_minmax(0,1fr)]"
    : "grid-cols-1";

  if (loading) {
    return (
      <div ref={panelRef} className={cn("grid min-w-0 gap-4", panelGridClass, className)}>
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

  if (!selectedWidget) {
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
      active={active}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen((current) => !current)}
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
        ref={panelRef}
        className={cn(
          "relative grid h-full min-h-0 min-w-0 gap-4 overflow-x-hidden",
          panelGridClass,
          className,
        )}
      >
        <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <CardHeader className="gap-3 px-3.5 pb-2.5 pt-3.5 md:px-4 md:pt-4">
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
              <div className="min-w-0 space-y-2 px-2.5 pb-2.5 pt-0 md:px-3 md:pb-3">
                {widgets.map((widget) => (
                  <button
                    key={widget.id}
                    type="button"
                    onClick={() => setSelectedWidgetId(widget.id)}
                    className={cn(
                      "block w-full min-w-0 max-w-full overflow-hidden rounded-2xl border px-2.5 py-2.5 text-left transition-colors",
                      widget.id === selectedWidgetId
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border/70 bg-card hover:border-primary/40 hover:bg-accent/40",
                    )}
                  >
                    <div className="grid min-w-0 max-w-full gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{widget.name}</p>
                        {widget.description && (
                          <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                            {widget.description}
                          </p>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                        <Badge
                          variant={widget.status === "active" ? "default" : "outline"}
                          className="shrink-0 capitalize"
                        >
                          {widget.status}
                        </Badge>
                        <Badge variant="outline" className="shrink-0">
                          {widget.controls.length} control{widget.controls.length === 1 ? "" : "s"}
                        </Badge>
                      </div>
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
