export const DASHBOARD_WIDGET_GRID_COLUMNS = 12;
export const DASHBOARD_WIDGET_GRID_MIN_ROW_SPAN = 2;
export const DASHBOARD_WIDGET_GRID_MAX_ROW_SPAN = 8;

export interface DashboardWidgetGridItem {
  id: string;
  columnStart: number;
  columnSpan: number;
  rowStart: number;
  rowSpan: number;
  sortOrder: number;
  createdAt: string;
}

function compareDashboardWidgetGridItems(
  left: DashboardWidgetGridItem,
  right: DashboardWidgetGridItem,
): number {
  if (left.rowStart !== right.rowStart) {
    return left.rowStart - right.rowStart;
  }
  if (left.columnStart !== right.columnStart) {
    return left.columnStart - right.columnStart;
  }
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.id.localeCompare(right.id);
}

function getColumnEnd(item: DashboardWidgetGridItem): number {
  return item.columnStart + item.columnSpan - 1;
}

function getRowEnd(item: DashboardWidgetGridItem): number {
  return item.rowStart + item.rowSpan - 1;
}

function itemsOverlap(left: DashboardWidgetGridItem, right: DashboardWidgetGridItem): boolean {
  return !(
    getColumnEnd(left) < right.columnStart
    || getColumnEnd(right) < left.columnStart
    || getRowEnd(left) < right.rowStart
    || getRowEnd(right) < left.rowStart
  );
}

export function normalizeDashboardWidgetColumnSpan(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 6;
  }
  return Math.max(1, Math.min(DASHBOARD_WIDGET_GRID_COLUMNS, Math.round(numeric)));
}

export function normalizeDashboardWidgetRowSpan(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 4;
  }
  return Math.max(DASHBOARD_WIDGET_GRID_MIN_ROW_SPAN, Math.min(DASHBOARD_WIDGET_GRID_MAX_ROW_SPAN, Math.round(numeric)));
}

export function normalizeDashboardWidgetColumnStart(value: number, columnSpan: number): number {
  const nextColumnSpan = normalizeDashboardWidgetColumnSpan(columnSpan);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.min(
    DASHBOARD_WIDGET_GRID_COLUMNS - nextColumnSpan + 1,
    Math.round(numeric),
  ));
}

export function normalizeDashboardWidgetRowStart(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.round(numeric));
}

export function normalizeDashboardWidgetGridItem<T extends DashboardWidgetGridItem>(item: T): T {
  const columnSpan = normalizeDashboardWidgetColumnSpan(item.columnSpan);
  const rowSpan = normalizeDashboardWidgetRowSpan(item.rowSpan);
  const columnStart = normalizeDashboardWidgetColumnStart(item.columnStart, columnSpan);
  const rowStart = normalizeDashboardWidgetRowStart(item.rowStart);
  return {
    ...item,
    columnSpan,
    rowSpan,
    columnStart,
    rowStart,
    sortOrder: Number.isFinite(Number(item.sortOrder)) ? Math.max(0, Math.round(item.sortOrder)) : 0,
  };
}

export function sortDashboardWidgetGridItems<T extends DashboardWidgetGridItem>(items: T[]): T[] {
  return [...items].sort(compareDashboardWidgetGridItems);
}

export function resolveDashboardWidgetGridLayout<T extends DashboardWidgetGridItem>(
  items: T[],
  anchoredItemIds: string[] = [],
): T[] {
  const anchorOrder = new Map(anchoredItemIds.map((id, index) => [id, index]));
  const normalizedItems = items.map((item) => normalizeDashboardWidgetGridItem(item));
  const anchoredItems = normalizedItems
    .filter((item) => anchorOrder.has(item.id))
    .sort((left, right) => (
      (anchorOrder.get(left.id) ?? 0) - (anchorOrder.get(right.id) ?? 0)
    ));
  const floatingItems = sortDashboardWidgetGridItems(
    normalizedItems.filter((item) => !anchorOrder.has(item.id)),
  );
  const placedItems: T[] = [];

  const placeItem = (item: T) => {
    let candidate = normalizeDashboardWidgetGridItem(item);
    while (true) {
      const collisions = placedItems.filter((placedItem) => itemsOverlap(candidate, placedItem));
      if (collisions.length === 0) {
        break;
      }
      candidate = {
        ...candidate,
        rowStart: Math.max(...collisions.map((placedItem) => getRowEnd(placedItem))) + 1,
      };
    }
    placedItems.push(candidate);
  };

  anchoredItems.forEach(placeItem);
  floatingItems.forEach(placeItem);

  return sortDashboardWidgetGridItems(placedItems).map((item, index) => ({
    ...item,
    sortOrder: index,
  }));
}

export function findDashboardWidgetGridPlacement<T extends DashboardWidgetGridItem>(
  items: T[],
  columnSpan: number,
  rowSpan: number,
): Pick<DashboardWidgetGridItem, "columnStart" | "rowStart"> {
  const normalizedColumnSpan = normalizeDashboardWidgetColumnSpan(columnSpan);
  const normalizedRowSpan = normalizeDashboardWidgetRowSpan(rowSpan);
  const placedItems = resolveDashboardWidgetGridLayout(items);
  const maxColumnStart = DASHBOARD_WIDGET_GRID_COLUMNS - normalizedColumnSpan + 1;

  for (let rowStart = 1; rowStart <= 1_000; rowStart += 1) {
    for (let columnStart = 1; columnStart <= maxColumnStart; columnStart += 1) {
      const candidate: DashboardWidgetGridItem = {
        id: "__candidate__",
        columnStart,
        columnSpan: normalizedColumnSpan,
        rowStart,
        rowSpan: normalizedRowSpan,
        sortOrder: Number.MAX_SAFE_INTEGER,
        createdAt: "",
      };
      if (!placedItems.some((item) => itemsOverlap(candidate, item))) {
        return { columnStart, rowStart };
      }
    }
  }

  const lastRow = placedItems.length === 0
    ? 1
    : Math.max(...placedItems.map((item) => getRowEnd(item))) + 1;

  return {
    columnStart: 1,
    rowStart: lastRow,
  };
}
