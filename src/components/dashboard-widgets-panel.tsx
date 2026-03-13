"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  GripVertical,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { withClientApiToken } from "@/lib/auth/client-token";
import {
  DASHBOARD_WIDGET_GRID_COLUMNS,
  normalizeDashboardWidgetColumnSpan,
  normalizeDashboardWidgetColumnStart,
  normalizeDashboardWidgetRowSpan,
  normalizeDashboardWidgetRowStart,
  resolveDashboardWidgetGridLayout,
} from "@/lib/dashboard-widget-grid";
import type {
  DashboardWidgetInventoryEntry,
  DashboardWidgetPage,
  DashboardWidgetPageItem,
} from "@/lib/state/types";
import { cn } from "@/lib/utils";
import { DeviceWidgetRuntimeFrame } from "@/components/device-widget-runtime-frame";

interface DashboardWidgetsPanelProps {
  active?: boolean;
  toolbarSlot?: HTMLElement | null;
  className?: string;
}

interface ResizePreview {
  columnSpan: number;
  rowSpan: number;
}

interface PositionPreview {
  columnStart: number;
  rowStart: number;
}

interface GridMetrics {
  columns: number;
  columnWidth: number;
  rowUnit: number;
  rect: DOMRect;
}

type PendingDeleteTarget =
  | { kind: "page"; pageId: string; name: string }
  | { kind: "item"; itemId: string; name: string; pageName: string }
  | null;

const GRID_GAP_PX = 12;
const GRID_ROW_HEIGHT_PX = 120;
const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";

function replacePage(pages: DashboardWidgetPage[], page: DashboardWidgetPage): DashboardWidgetPage[] {
  const nextPages = pages.some((candidate) => candidate.id === page.id)
    ? pages.map((candidate) => (candidate.id === page.id ? page : candidate))
    : [...pages, page];

  return [...nextPages].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function createInteractionShield(cursor: string): HTMLDivElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const shield = document.createElement("div");
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    zIndex: "55",
    background: "transparent",
    cursor,
  });
  document.body.appendChild(shield);
  return shield;
}

function DashboardWidgetTile({
  item,
  resizePreview,
  positionPreview,
  active,
  fullscreen,
  isDesktop,
  getGridMetrics,
  onPositionPreviewChange,
  onMoveCommit,
  onMoveStart,
  onMoveEnd,
  onResizePreviewChange,
  onResizeCommit,
  onToggleFullscreen,
  onRemove,
  dragState,
}: {
  item: DashboardWidgetPageItem;
  resizePreview?: ResizePreview;
  positionPreview?: PositionPreview;
  active: boolean;
  fullscreen: boolean;
  isDesktop: boolean;
  getGridMetrics: () => GridMetrics | null;
  onPositionPreviewChange: (next: PositionPreview | null) => void;
  onMoveCommit: (next: PositionPreview) => void;
  onMoveStart: () => void;
  onMoveEnd: () => void;
  onResizePreviewChange: (next: ResizePreview | null) => void;
  onResizeCommit: (next: ResizePreview) => void;
  onToggleFullscreen: () => void;
  onRemove: () => void;
  dragState: "idle" | "dragging";
}) {
  const runtimeWidget = useMemo(() => ({
    id: item.widget.widgetId,
    deviceId: item.widget.deviceId,
    slug: item.widget.widgetSlug,
    name: item.widget.widgetName,
    description: item.widget.widgetDescription,
    status: item.widget.widgetStatus,
    html: "",
    css: "",
    js: "",
    capabilities: item.widget.capabilities,
    controls: [],
    createdBy: "user" as const,
    revision: item.widget.widgetRevision,
    createdAt: item.createdAt,
    updatedAt: item.widget.updatedAt,
  }), [item]);

  const resizePreviewRef = useRef<ResizePreview | null>(resizePreview ?? null);
  const positionPreviewRef = useRef<PositionPreview | null>(positionPreview ?? null);
  const moveGestureActiveRef = useRef(false);
  const resizeGestureActiveRef = useRef(false);

  useEffect(() => {
    resizePreviewRef.current = resizePreview ?? null;
  }, [resizePreview]);

  useEffect(() => {
    positionPreviewRef.current = positionPreview ?? null;
  }, [positionPreview]);

  const handleMovePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (fullscreen || !isDesktop) {
      return;
    }
    if (moveGestureActiveRef.current) {
      return;
    }

    const metrics = getGridMetrics();
    if (!metrics) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startPosition: PositionPreview = {
      columnStart: item.columnStart,
      rowStart: item.rowStart,
    };
    const shield = createInteractionShield("grabbing");

    moveGestureActiveRef.current = true;
    positionPreviewRef.current = startPosition;
    onMoveStart();
    onPositionPreviewChange(startPosition);

    const updateMovePreview = (clientX: number, clientY: number) => {
      const relativeX = Math.max(0, clientX - metrics.rect.left);
      const relativeY = Math.max(0, clientY - metrics.rect.top);
      const nextPosition: PositionPreview = {
        columnStart: metrics.columns === 1
          ? 1
          : normalizeDashboardWidgetColumnStart(
            Math.floor(relativeX / (metrics.columnWidth + GRID_GAP_PX)) + 1,
            item.columnSpan,
          ),
        rowStart: normalizeDashboardWidgetRowStart(
          Math.floor(relativeY / metrics.rowUnit) + 1,
        ),
      };
      positionPreviewRef.current = nextPosition;
      onPositionPreviewChange(nextPosition);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateMovePreview(moveEvent.clientX, moveEvent.clientY);
    };
    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateMovePreview(moveEvent.clientX, moveEvent.clientY);
    };

    let finished = false;
    const finishMove = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishMove);
      window.removeEventListener("pointercancel", finishMove);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", finishMove);
      shield?.remove();
      moveGestureActiveRef.current = false;

      const nextPosition = positionPreviewRef.current ?? startPosition;
      onPositionPreviewChange(null);
      positionPreviewRef.current = null;
      onMoveEnd();

      if (
        nextPosition.columnStart !== item.columnStart
        || nextPosition.rowStart !== item.rowStart
      ) {
        onMoveCommit(nextPosition);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishMove);
    window.addEventListener("pointercancel", finishMove);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", finishMove);
  }, [
    fullscreen,
    getGridMetrics,
    isDesktop,
    item.columnSpan,
    item.columnStart,
    item.rowStart,
    onMoveCommit,
    onMoveEnd,
    onMoveStart,
    onPositionPreviewChange,
  ]);

  const handleResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>,
  ) => {
    if (fullscreen || !isDesktop) {
      return;
    }
    if (resizeGestureActiveRef.current) {
      return;
    }

    const metrics = getGridMetrics();
    if (!metrics) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startSize: ResizePreview = {
      columnSpan: item.columnSpan,
      rowSpan: item.rowSpan,
    };
    const shield = createInteractionShield("se-resize");

    resizeGestureActiveRef.current = true;
    resizePreviewRef.current = startSize;
    onResizePreviewChange(startSize);

    const updateResizePreview = (clientX: number, clientY: number) => {
      const deltaColumns = metrics.columns === 1
        ? 0
        : Math.round((clientX - startX) / metrics.columnWidth);
      const deltaRows = Math.round((clientY - startY) / metrics.rowUnit);
      const nextSize: ResizePreview = {
        columnSpan: metrics.columns === 1
          ? item.columnSpan
          : normalizeDashboardWidgetColumnSpan(startSize.columnSpan + deltaColumns),
        rowSpan: normalizeDashboardWidgetRowSpan(startSize.rowSpan + deltaRows),
      };
      resizePreviewRef.current = nextSize;
      onResizePreviewChange(nextSize);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateResizePreview(moveEvent.clientX, moveEvent.clientY);
    };
    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateResizePreview(moveEvent.clientX, moveEvent.clientY);
    };

    let finished = false;
    const finishResize = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", finishResize);
      shield?.remove();
      resizeGestureActiveRef.current = false;

      const nextSize = resizePreviewRef.current ?? startSize;
      onResizePreviewChange(null);
      resizePreviewRef.current = null;

      if (
        nextSize.columnSpan !== item.columnSpan
        || nextSize.rowSpan !== item.rowSpan
      ) {
        onResizeCommit(nextSize);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", finishResize);
  }, [
    fullscreen,
    getGridMetrics,
    isDesktop,
    item.columnSpan,
    item.rowSpan,
    onResizePreviewChange,
    onResizeCommit,
  ]);

  return (
    <Card
      className={cn(
        "group/widget-card relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        fullscreen && "rounded-[28px] border-border/70 bg-background/95 shadow-2xl",
        dragState === "dragging" && "opacity-50",
        (resizePreview || positionPreview) && "border-primary ring-1 ring-primary/40",
      )}
    >
      {!fullscreen && (
        <>
          <button
            type="button"
            onPointerDown={handleMovePointerDown}
            onMouseDown={handleMovePointerDown}
            className="absolute left-2 top-2 z-20 flex h-7 w-7 cursor-grab items-center justify-center rounded-full text-muted-foreground/65 opacity-60 transition-opacity hover:opacity-100 hover:text-foreground active:cursor-grabbing"
            aria-label="Move widget tile"
          >
            <GripVertical className="size-3.5" />
          </button>
          <div className="pointer-events-none absolute right-2 top-2 z-20">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-1 text-muted-foreground shadow-sm transition-opacity duration-150",
                "opacity-90 md:opacity-0 md:group-hover/widget-card:opacity-100 md:group-focus-within/widget-card:opacity-100",
              )}
            >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={onToggleFullscreen}
                className="h-7 w-7 rounded-full text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              >
                <Maximize2 className="size-3.5" />
                <span className="sr-only">Expand widget</span>
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={onRemove}
                className="h-7 w-7 rounded-full text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only">Remove widget</span>
              </Button>
            </div>
          </div>
          {isDesktop && (
            <button
              type="button"
              onPointerDown={handleResizePointerDown}
              onMouseDown={handleResizePointerDown}
              className="absolute bottom-2 right-2 z-20 flex h-7 w-7 cursor-se-resize touch-none items-center justify-center rounded-full text-muted-foreground/65 opacity-60 transition-opacity hover:opacity-100 hover:text-foreground"
              aria-label="Resize widget tile"
            >
              <GripVertical className="size-3.5 rotate-45" />
            </button>
          )}
        </>
      )}
      {fullscreen && (
        <div className="pointer-events-none absolute right-3 top-3 z-20">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onToggleFullscreen}
            className="pointer-events-auto h-8 w-8 rounded-full border border-border/60 bg-background/72 text-muted-foreground shadow-sm backdrop-blur-sm hover:bg-background hover:text-foreground"
          >
            <Minimize2 className="size-4" />
            <span className="sr-only">Exit widget fullscreen</span>
          </Button>
        </div>
      )}
      <CardContent className="flex min-h-0 min-w-0 flex-1 overflow-hidden p-0 md:p-0">
        <DeviceWidgetRuntimeFrame
          deviceId={item.widget.deviceId}
          widget={runtimeWidget}
          active={active}
          fullscreen={fullscreen}
          onToggleFullscreen={onToggleFullscreen}
          showFullscreenButton={false}
          maxFrameHeight={fullscreen ? 4_000 : 1_600}
          fillAvailableHeight
          showRuntimeBadges={false}
          className="h-full w-full flex-1"
        />
      </CardContent>
    </Card>
  );
}

export function DashboardWidgetsPanel({ active = false, toolbarSlot = null, className }: DashboardWidgetsPanelProps) {
  const [pages, setPages] = useState<DashboardWidgetPage[]>([]);
  const [inventory, setInventory] = useState<DashboardWidgetInventoryEntry[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [canvasFullscreen, setCanvasFullscreen] = useState(false);
  const [fullscreenItemId, setFullscreenItemId] = useState<string | null>(null);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [positionPreviewByItem, setPositionPreviewByItem] = useState<Record<string, PositionPreview>>({});
  const [resizePreviewByItem, setResizePreviewByItem] = useState<Record<string, ResizePreview>>({});
  const [isDesktop, setIsDesktop] = useState(false);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingDeleteTarget>(null);
  const [deleting, setDeleting] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/widgets", withClientApiToken());
      const payload = (await response.json()) as {
        pages?: DashboardWidgetPage[];
        inventory?: DashboardWidgetInventoryEntry[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to load dashboard widgets.");
      }
      setPages(payload.pages ?? []);
      setInventory(payload.inventory ?? []);
      setPositionPreviewByItem({});
      setResizePreviewByItem({});
      setSelectedPageId((current) => {
        if (current && (payload.pages ?? []).some((page) => page.id === current)) {
          return current;
        }
        return payload.pages?.[0]?.id ?? null;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setHasLoaded(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || hasLoaded) {
      return;
    }
    void loadData();
  }, [active, hasLoaded, loadData]);

  useEffect(() => {
    if (!active) {
      setCanvasFullscreen(false);
      setFullscreenItemId(null);
      setDraggingItemId(null);
      setPositionPreviewByItem({});
      setResizePreviewByItem({});
      setPickerOpen(false);
      setPendingDeleteTarget(null);
      setDeleting(false);
    }
  }, [active]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    if ((!fullscreenItemId && !canvasFullscreen) || typeof document === "undefined") {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (fullscreenItemId) {
          setFullscreenItemId(null);
          return;
        }
        setCanvasFullscreen(false);
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [canvasFullscreen, fullscreenItemId]);

  const activePage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? null,
    [pages, selectedPageId],
  );

  const displayItems = useMemo(() => {
    if (!activePage) {
      return [];
    }

    const previewItemIds = Array.from(new Set([
      ...Object.keys(positionPreviewByItem),
      ...Object.keys(resizePreviewByItem),
    ]));

    return resolveDashboardWidgetGridLayout(
      activePage.items.map((item) => ({
        ...item,
        columnStart: positionPreviewByItem[item.id]?.columnStart ?? item.columnStart,
        columnSpan: resizePreviewByItem[item.id]?.columnSpan ?? item.columnSpan,
        rowStart: positionPreviewByItem[item.id]?.rowStart ?? item.rowStart,
        rowSpan: resizePreviewByItem[item.id]?.rowSpan ?? item.rowSpan,
      })),
      previewItemIds,
    );
  }, [activePage, positionPreviewByItem, resizePreviewByItem]);

  const activeItemMap = useMemo(
    () => new Map(activePage?.items.map((item) => [item.id, item]) ?? []),
    [activePage],
  );

  const fullscreenItem = useMemo(
    () => activePage?.items.find((item) => item.id === fullscreenItemId) ?? null,
    [activePage, fullscreenItemId],
  );

  useEffect(() => {
    if (fullscreenItemId && !fullscreenItem) {
      setFullscreenItemId(null);
    }
  }, [fullscreenItem, fullscreenItemId]);

  const filteredInventory = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    if (!query) {
      return inventory;
    }
    return inventory.filter((entry) => {
      const haystack = [
        entry.widgetName,
        entry.widgetSlug,
        entry.widgetDescription ?? "",
        entry.deviceName,
        entry.deviceIp,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [inventory, pickerQuery]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }, [loadData]);

  const createPage = useCallback(async () => {
    const name = window.prompt("Name the new widget page", `Widget Page ${pages.length + 1}`);
    if (!name?.trim()) {
      return;
    }

    try {
      const response = await fetch(
        "/api/dashboard/widgets",
        withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      );
      const payload = (await response.json()) as { page?: DashboardWidgetPage; error?: string };
      if (!response.ok || !payload.page) {
        throw new Error(payload.error ?? "Failed to create widget page.");
      }
      setPages((current) => replacePage(current, payload.page as DashboardWidgetPage));
      setSelectedPageId(payload.page.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [pages.length]);

  const renamePage = useCallback(async () => {
    if (!activePage) {
      return;
    }
    const name = window.prompt("Rename widget page", activePage.name);
    if (!name?.trim() || name.trim() === activePage.name) {
      return;
    }

    try {
      const response = await fetch(
        `/api/dashboard/widgets/pages/${activePage.id}`,
        withClientApiToken({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      );
      const payload = (await response.json()) as { page?: DashboardWidgetPage; error?: string };
      if (!response.ok || !payload.page) {
        throw new Error(payload.error ?? "Failed to rename widget page.");
      }
      setPages((current) => replacePage(current, payload.page as DashboardWidgetPage));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [activePage]);

  const requestDeletePage = useCallback(() => {
    if (!activePage) {
      return;
    }

    setPendingDeleteTarget({
      kind: "page",
      pageId: activePage.id,
      name: activePage.name,
    });
  }, [activePage]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteTarget) {
      return;
    }

    setDeleting(true);
    try {
      if (pendingDeleteTarget.kind === "page") {
        const response = await fetch(
          `/api/dashboard/widgets/pages/${pendingDeleteTarget.pageId}`,
          withClientApiToken({ method: "DELETE" }),
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to delete widget page.");
        }

        const remainingPages = pages.filter((page) => page.id !== pendingDeleteTarget.pageId);
        setPages(remainingPages);
        setSelectedPageId((current) => {
          if (current !== pendingDeleteTarget.pageId) {
            return current;
          }
          return remainingPages[0]?.id ?? null;
        });
        setPositionPreviewByItem({});
        setResizePreviewByItem({});
      } else {
        const response = await fetch(
          `/api/dashboard/widgets/items/${pendingDeleteTarget.itemId}`,
          withClientApiToken({ method: "DELETE" }),
        );
        const payload = (await response.json()) as { page?: DashboardWidgetPage | null; pageId?: string; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to remove dashboard widget tile.");
        }

        if (payload.page) {
          setPages((current) => replacePage(current, payload.page as DashboardWidgetPage));
        } else if (payload.pageId) {
          setPages((current) => current.map((page) => (
            page.id === payload.pageId
              ? { ...page, items: page.items.filter((item) => item.id !== pendingDeleteTarget.itemId) }
              : page
          )));
        }

        setPositionPreviewByItem((current) => {
          const next = { ...current };
          delete next[pendingDeleteTarget.itemId];
          return next;
        });
        setResizePreviewByItem((current) => {
          const next = { ...current };
          delete next[pendingDeleteTarget.itemId];
          return next;
        });

        if (fullscreenItemId === pendingDeleteTarget.itemId) {
          setFullscreenItemId(null);
        }
      }

      setPendingDeleteTarget(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      await loadData();
    } finally {
      setDeleting(false);
    }
  }, [fullscreenItemId, loadData, pages, pendingDeleteTarget]);

  const addWidgetToPage = useCallback(async (widgetId: string) => {
    if (!activePage) {
      setError("Create a widget page before adding widgets.");
      return;
    }

    try {
      const response = await fetch(
        `/api/dashboard/widgets/pages/${activePage.id}/items`,
        withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widgetId }),
        }),
      );
      const payload = (await response.json()) as { page?: DashboardWidgetPage; error?: string };
      if (!response.ok || !payload.page) {
        throw new Error(payload.error ?? "Failed to add widget to page.");
      }
      setPages((current) => replacePage(current, payload.page as DashboardWidgetPage));
      setPickerOpen(false);
      setPickerQuery("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [activePage]);

  const updateItem = useCallback(async (
    itemId: string,
    body: Partial<Pick<DashboardWidgetPageItem, "columnStart" | "columnSpan" | "rowStart" | "rowSpan" | "sortOrder">> & { title?: string | null },
  ) => {
    try {
      const response = await fetch(
        `/api/dashboard/widgets/items/${itemId}`,
        withClientApiToken({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const payload = (await response.json()) as { page?: DashboardWidgetPage; error?: string };
      if (!response.ok || !payload.page) {
        throw new Error(payload.error ?? "Failed to update dashboard widget tile.");
      }
      setPages((current) => replacePage(current, payload.page as DashboardWidgetPage));
      setPositionPreviewByItem((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
      setResizePreviewByItem((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      await loadData();
    }
  }, [loadData]);

  const requestRemoveItem = useCallback((item: DashboardWidgetPageItem) => {
    setPendingDeleteTarget({
      kind: "item",
      itemId: item.id,
      name: item.title?.trim() || item.widget.widgetName,
      pageName: activePage?.name ?? "this page",
    });
  }, [activePage?.name]);

  const getGridMetrics = useCallback((): GridMetrics | null => {
    const node = gridRef.current;
    if (!node) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    const columns = isDesktop ? DASHBOARD_WIDGET_GRID_COLUMNS : 1;
    const columnWidth = columns === 1
      ? rect.width
      : (rect.width - (GRID_GAP_PX * (columns - 1))) / columns;

    if (!Number.isFinite(columnWidth) || columnWidth <= 0) {
      return null;
    }

    return {
      columns,
      columnWidth,
      rect,
      rowUnit: GRID_ROW_HEIGHT_PX + GRID_GAP_PX,
    };
  }, [isDesktop]);

  const widgetToolbar = active && toolbarSlot
    ? createPortal(
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => void refreshAll()} disabled={refreshing}>
          <RefreshCw className={cn("mr-2 size-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
        <Button size="sm" variant="outline" onClick={() => void createPage()}>
          <Plus className="mr-2 size-3.5" />
          New Page
        </Button>
        <Button size="sm" variant="outline" onClick={() => void renamePage()} disabled={!activePage}>
          <Pencil className="mr-2 size-3.5" />
          Rename
        </Button>
        <Button size="sm" variant="outline" onClick={requestDeletePage} disabled={!activePage}>
          <Trash2 className="mr-2 size-3.5" />
          Delete
        </Button>
      </div>,
      toolbarSlot,
    )
    : null;

  if (loading) {
    return (
      <>
        {widgetToolbar}
        <div className={cn("space-y-3", className)}>
          <Skeleton className="h-7 w-80 rounded-full" />
          <Skeleton className="h-[720px] w-full rounded-2xl" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        {widgetToolbar}
        <Card className={cn("border-destructive/50", className)}>
          <CardHeader>
            <CardTitle className="text-destructive">Dashboard widgets unavailable</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  const fullscreenOverlay = fullscreenItem && typeof document !== "undefined"
    ? createPortal(
      <div className="fixed inset-y-0 left-0 right-0 z-[60] bg-background/86 backdrop-blur-sm md:left-[var(--steward-sidebar-width)]">
        <div className="flex h-full min-h-0 flex-col p-2 md:p-3 lg:p-4">
          <DashboardWidgetTile
            item={fullscreenItem}
            active={active}
            fullscreen
            isDesktop={isDesktop}
            resizePreview={undefined}
            positionPreview={undefined}
            getGridMetrics={getGridMetrics}
            onPositionPreviewChange={() => undefined}
            onMoveCommit={() => undefined}
            onMoveStart={() => undefined}
            onMoveEnd={() => undefined}
            onResizePreviewChange={() => undefined}
            onResizeCommit={() => undefined}
            onToggleFullscreen={() => setFullscreenItemId(null)}
            onRemove={() => requestRemoveItem(fullscreenItem)}
            dragState="idle"
          />
        </div>
      </div>,
      document.body,
    )
    : null;

  const canvasContent = !activePage ? (
    <div className="flex min-h-[420px] flex-1 items-center justify-center rounded-[24px] border border-dashed border-border/70 bg-muted/20 px-6 py-10">
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
          <LayoutGrid className="size-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium">Create a widget page first</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Each page starts empty. Add widgets after you name the page.
          </p>
        </div>
        <Button onClick={() => void createPage()}>
          <Plus className="mr-2 size-4" />
          New Page
        </Button>
      </div>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 overflow-auto rounded-[24px] border border-dashed border-border/70 bg-muted/20 p-2 md:p-3">
      {activePage.items.length === 0 ? (
        <div className="flex min-h-full w-full flex-col items-center justify-center gap-4 rounded-[20px] border border-dashed border-border/70 bg-background/80 px-6 py-10 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <LayoutGrid className="size-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium">This page is empty</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a saved device widget and start arranging the grid.
            </p>
          </div>
          <Button onClick={() => setPickerOpen(true)}>
            <Plus className="mr-2 size-4" />
            Add Widget
          </Button>
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid min-h-full w-full auto-rows-[120px] grid-cols-1 gap-3 lg:grid-cols-12"
        >
          {displayItems.map((displayItem) => {
            const item = activeItemMap.get(displayItem.id);
            if (!item) {
              return null;
            }

            const resizePreview = resizePreviewByItem[item.id];
            const positionPreview = positionPreviewByItem[item.id];
            const columnStart = isDesktop
              ? normalizeDashboardWidgetColumnStart(displayItem.columnStart, displayItem.columnSpan)
              : 1;
            const columnSpan = isDesktop
              ? normalizeDashboardWidgetColumnSpan(displayItem.columnSpan)
              : 1;
            const rowStart = normalizeDashboardWidgetRowStart(displayItem.rowStart);
            const rowSpan = normalizeDashboardWidgetRowSpan(displayItem.rowSpan);

            return (
              <div
                key={item.id}
                className="min-h-0 min-w-0"
                style={{
                  gridColumn: `${columnStart} / span ${columnSpan}`,
                  gridRow: isDesktop
                    ? `${rowStart} / span ${rowSpan}`
                    : `span ${rowSpan} / span ${rowSpan}`,
                }}
              >
                <DashboardWidgetTile
                  item={item}
                  resizePreview={resizePreview}
                  positionPreview={positionPreview}
                  active={active && fullscreenItemId === null}
                  fullscreen={false}
                  isDesktop={isDesktop}
                  getGridMetrics={getGridMetrics}
                  onPositionPreviewChange={(next) => {
                    setPositionPreviewByItem((current) => {
                      const updated = { ...current };
                      if (next) {
                        updated[item.id] = next;
                      } else {
                        delete updated[item.id];
                      }
                      return updated;
                    });
                  }}
                  onMoveCommit={(next) => void updateItem(item.id, next)}
                  onMoveStart={() => {
                    setDraggingItemId(item.id);
                  }}
                  onMoveEnd={() => {
                    setDraggingItemId(null);
                  }}
                  onResizePreviewChange={(next) => {
                    setResizePreviewByItem((current) => {
                      const updated = { ...current };
                      if (next) {
                        updated[item.id] = next;
                      } else {
                        delete updated[item.id];
                      }
                      return updated;
                    });
                  }}
                  onResizeCommit={(next) => void updateItem(item.id, next)}
                  onToggleFullscreen={() => setFullscreenItemId(item.id)}
                  onRemove={() => requestRemoveItem(item)}
                  dragState={draggingItemId === item.id ? "dragging" : "idle"}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const canvasSurface = (
    <div className="group/widget-canvas relative flex min-h-0 flex-1 flex-col">
      {activePage && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={canvasFullscreen ? "Exit widget canvas fullscreen" : "Enter widget canvas fullscreen"}
          className={cn(
            "absolute right-3 top-3 z-10 h-8 w-8 rounded-full border border-border/60 bg-background/72 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity duration-150",
            "opacity-100 hover:bg-background hover:text-foreground md:opacity-0 md:focus-visible:opacity-100 md:group-hover/widget-canvas:opacity-100 md:group-focus-within/widget-canvas:opacity-100",
          )}
          onClick={() => setCanvasFullscreen((current) => !current)}
        >
          {canvasFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </Button>
      )}
      {canvasContent}
    </div>
  );

  const canvasFullscreenOverlay = canvasFullscreen && typeof document !== "undefined"
    ? createPortal(
      <div className="fixed inset-y-0 left-0 right-0 z-[60] bg-background/86 backdrop-blur-sm md:left-[var(--steward-sidebar-width)]">
        <div className="flex h-full min-h-0 flex-col p-2 md:p-3 lg:p-4">
          {canvasSurface}
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <Dialog
        open={pendingDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDeleteTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingDeleteTarget?.kind === "page" ? "Delete widget page?" : "Remove widget from page?"}
            </DialogTitle>
            <DialogDescription>
              {pendingDeleteTarget?.kind === "page"
                ? `Delete "${pendingDeleteTarget.name}" and all widget placements on this page? This cannot be undone.`
                : pendingDeleteTarget
                  ? `Remove "${pendingDeleteTarget.name}" from ${pendingDeleteTarget.pageName}? The saved device widget will still be available to add again later.`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={!pendingDeleteTarget || deleting}>
              {deleting
                ? pendingDeleteTarget?.kind === "page"
                  ? "Deleting..."
                  : "Removing..."
                : pendingDeleteTarget?.kind === "page"
                  ? "Delete Page"
                  : "Remove Widget"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="grid h-[min(85vh,760px)] max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add Widget</DialogTitle>
            <DialogDescription>
              Choose a saved device widget to place on {activePage?.name ?? "this page"}.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={pickerQuery}
            onChange={(event) => setPickerQuery(event.target.value)}
            placeholder="Search widgets or devices"
          />
          <div className="min-h-0 overflow-y-auto rounded-2xl border border-border/70 pr-1">
            <div className="space-y-2 p-3">
              {filteredInventory.length === 0 ? (
                <div className="rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">
                  No matching device widgets.
                </div>
              ) : (
                filteredInventory.map((entry) => (
                  <button
                    key={`${entry.deviceId}:${entry.widgetId}`}
                    type="button"
                    onClick={() => void addWidgetToPage(entry.widgetId)}
                    className="flex w-full items-start gap-3 rounded-2xl border border-border/70 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/35"
                  >
                    <div className="mt-0.5 rounded-xl bg-primary/10 p-2 text-primary">
                      <LayoutGrid className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-foreground">{entry.widgetName}</p>
                        <Badge variant="outline">{entry.widgetSlug}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.deviceName} · {entry.deviceIp || entry.deviceId}
                      </p>
                      {entry.widgetDescription && (
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {entry.widgetDescription}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant={entry.widgetStatus === "active" ? "default" : "outline"}
                      className="shrink-0 capitalize"
                    >
                      {entry.widgetStatus}
                    </Badge>
                  </button>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {widgetToolbar}

      <div className={cn("flex min-h-0 flex-1 flex-col gap-2", className)}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex flex-1 flex-wrap gap-1.5">
            {pages.map((page) => (
              <button
                key={page.id}
                type="button"
                onClick={() => {
                  setSelectedPageId(page.id);
                  setPositionPreviewByItem({});
                  setResizePreviewByItem({});
                }}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-xs leading-5 transition-colors",
                  page.id === activePage?.id
                    ? "border-primary bg-primary/8 text-foreground"
                    : "border-border/70 bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {page.name}
              </button>
            ))}
            {pages.length === 0 && (
              <div className="rounded-full border border-dashed px-2.5 py-0.5 text-xs leading-5 text-muted-foreground">
                No pages yet
              </div>
            )}
          </div>
          {activePage && (
            <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => setPickerOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add Widget
            </Button>
          )}
        </div>

        {!canvasFullscreen && canvasSurface}
      </div>
      {canvasFullscreenOverlay}
      {fullscreenOverlay}
    </>
  );
}
