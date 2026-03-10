export const MAX_WIDGET_DESCRIPTION_LENGTH = 96;

export function normalizeWidgetDescription(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= MAX_WIDGET_DESCRIPTION_LENGTH) {
    return normalized;
  }

  const hardLimit = Math.max(1, MAX_WIDGET_DESCRIPTION_LENGTH - 3);
  const sliced = normalized.slice(0, hardLimit).trimEnd();
  const wordBoundary = sliced.lastIndexOf(" ");
  const safeSlice = wordBoundary >= Math.floor(MAX_WIDGET_DESCRIPTION_LENGTH * 0.6)
    ? sliced.slice(0, wordBoundary).trimEnd()
    : sliced;

  return `${safeSlice || sliced}...`;
}
