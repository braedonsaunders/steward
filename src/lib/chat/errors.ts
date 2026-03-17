import type { LLMProvider } from "@/lib/state/types";

const GENERIC_ERROR_PATTERNS = [
  /^error$/i,
  /^unknown error$/i,
  /^an unknown (structured )?error occurred\.?$/i,
  /^request failed(?: with \d+)?$/i,
  /^internal server error$/i,
  /^api error$/i,
  /^[a-z0-9_]+_error$/i,
];

const PRIORITY_KEYS = [
  "message",
  "error",
  "detail",
  "details",
  "reason",
  "cause",
  "responseBody",
  "body",
  "data",
  "issues",
  "errors",
  "statusText",
  "title",
  "description",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeaningfulErrorMessage(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !GENERIC_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function maybeParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function getProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function collectErrorCandidates(
  value: unknown,
  candidates: string[],
  seen: WeakSet<object>,
  depth = 0,
): void {
  if (depth > 6 || value == null) {
    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const parsed = maybeParseJsonString(trimmed);
    if (parsed !== undefined) {
      collectErrorCandidates(parsed, candidates, seen, depth + 1);
      candidates.push(trimmed);
      return;
    }
    candidates.push(trimmed);
    return;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    candidates.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectErrorCandidates(entry, candidates, seen, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (value instanceof Error) {
    candidates.push(value.message);
  }

  for (const key of PRIORITY_KEYS) {
    const nested = getProperty(value, key);
    if (nested !== undefined) {
      collectErrorCandidates(nested, candidates, seen, depth + 1);
    }
  }

  const ownKeys = value instanceof Error
    ? Object.getOwnPropertyNames(value)
    : Object.keys(value);
  for (const key of ownKeys) {
    if ((PRIORITY_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    const nested = getProperty(value, key);
    if (nested !== undefined) {
      collectErrorCandidates(nested, candidates, seen, depth + 1);
    }
  }
}

function providerLabel(provider: LLMProvider): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "cohere":
      return "Cohere";
    case "mistral":
      return "Mistral";
    case "groq":
      return "Groq";
    case "xai":
      return "xAI";
    default:
      return provider;
  }
}

export function stringifyUnknownChatError(value: unknown): string {
  const candidates: string[] = [];
  collectErrorCandidates(value, candidates, new WeakSet<object>());

  const meaningful = candidates.find((candidate) => isMeaningfulErrorMessage(candidate));
  if (meaningful) {
    return meaningful;
  }

  const fallback = candidates.find((candidate) => candidate.trim().length > 0);
  if (fallback) {
    return fallback;
  }

  if (isRecord(value)) {
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}") {
        return json;
      }
    } catch {
      // no-op
    }
  }

  return "An unknown error occurred.";
}

export function toFriendlyChatError(rawMessage: string, provider: LLMProvider): string {
  const trimmed = rawMessage.trim();
  const label = providerLabel(provider);

  if (
    provider === "openai" &&
    /missing scopes|insufficient permissions/i.test(trimmed)
  ) {
    return `OpenAI authentication issue: ${trimmed}. Disconnect and reconnect via OAuth in Settings, or add a Platform API key directly.`;
  }

  if (
    provider === "anthropic" &&
    /authentication|authorization|oauth|forbidden|permission|scope|unauthorized|unauthenticated|invalid x-api-key|invalid api key/i.test(trimmed)
  ) {
    return `Anthropic authentication issue: ${trimmed}. Reconnect Anthropic in Settings or add a valid API key directly.`;
  }

  if (!isMeaningfulErrorMessage(trimmed)) {
    return `${label} request failed without a usable error message. Check the provider connection or credentials in Settings, then retry.`;
  }

  return trimmed;
}

export function normalizeChatError(value: unknown, provider: LLMProvider): string {
  return toFriendlyChatError(stringifyUnknownChatError(value), provider);
}
