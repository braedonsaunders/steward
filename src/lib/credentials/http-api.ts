export const HTTP_API_AUTH_MODES = [
  "basic",
  "bearer",
  "api-key",
  "query-param",
  "path-segment",
] as const;

export type HttpApiCredentialAuthMode = (typeof HTTP_API_AUTH_MODES)[number];

export interface HttpApiCredentialAuth {
  mode: HttpApiCredentialAuthMode;
  headerName?: string;
  queryParamName?: string;
  pathPrefix?: string;
}

const DEFAULT_HTTP_API_AUTH_MODE: HttpApiCredentialAuthMode = "basic";
const DEFAULT_HTTP_API_API_KEY_HEADER = "X-API-Key";
const DEFAULT_HTTP_API_QUERY_PARAM = "api_key";
const DEFAULT_HTTP_API_PATH_PREFIX = "/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMode(value: unknown): HttpApiCredentialAuthMode {
  if (typeof value !== "string") {
    return DEFAULT_HTTP_API_AUTH_MODE;
  }
  const normalized = value.trim().toLowerCase();
  return HTTP_API_AUTH_MODES.includes(normalized as HttpApiCredentialAuthMode)
    ? normalized as HttpApiCredentialAuthMode
    : DEFAULT_HTTP_API_AUTH_MODE;
}

function normalizeHeaderName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9-]+$/.test(trimmed) ? trimmed : undefined;
}

function normalizeQueryParamName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : undefined;
}

function normalizePathPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefixed === "/") {
    return "/";
  }
  return prefixed.replace(/\/+$/, "");
}

function serializeAuth(auth: HttpApiCredentialAuth): Record<string, unknown> {
  const serialized: Record<string, unknown> = { mode: auth.mode };
  if (auth.headerName) {
    serialized.headerName = auth.headerName;
  }
  if (auth.queryParamName) {
    serialized.queryParamName = auth.queryParamName;
  }
  if (auth.pathPrefix) {
    serialized.pathPrefix = auth.pathPrefix;
  }
  return serialized;
}

export function getHttpApiCredentialAuth(scopeJson?: Record<string, unknown>): HttpApiCredentialAuth {
  const authSource = isRecord(scopeJson?.auth) ? scopeJson.auth : {};
  const mode = normalizeMode(authSource.mode);
  const headerName = normalizeHeaderName(authSource.headerName);
  const queryParamName = normalizeQueryParamName(authSource.queryParamName);
  const pathPrefix = normalizePathPrefix(authSource.pathPrefix);

  switch (mode) {
    case "api-key":
      return {
        mode,
        headerName: headerName ?? DEFAULT_HTTP_API_API_KEY_HEADER,
      };
    case "query-param":
      return {
        mode,
        queryParamName: queryParamName ?? DEFAULT_HTTP_API_QUERY_PARAM,
      };
    case "path-segment":
      return {
        mode,
        pathPrefix: pathPrefix ?? DEFAULT_HTTP_API_PATH_PREFIX,
      };
    default:
      return { mode };
  }
}

export function withHttpApiCredentialAuth(
  scopeJson?: Record<string, unknown>,
  override?: Partial<HttpApiCredentialAuth>,
): Record<string, unknown> {
  const nextScope = { ...(scopeJson ?? {}) };
  const auth = getHttpApiCredentialAuth(nextScope);
  const merged: HttpApiCredentialAuth = getHttpApiCredentialAuth({
    auth: {
      ...serializeAuth(auth),
      ...(override?.mode ? { mode: override.mode } : {}),
      ...(override?.headerName !== undefined ? { headerName: override.headerName } : {}),
      ...(override?.queryParamName !== undefined ? { queryParamName: override.queryParamName } : {}),
      ...(override?.pathPrefix !== undefined ? { pathPrefix: override.pathPrefix } : {}),
    },
  });

  return {
    ...nextScope,
    auth: serializeAuth(merged),
  };
}

export function requiresHttpApiAccountLabel(
  authOrScope?: HttpApiCredentialAuth | Record<string, unknown>,
): boolean {
  const auth = "mode" in (authOrScope ?? {})
    ? authOrScope as HttpApiCredentialAuth
    : getHttpApiCredentialAuth(authOrScope as Record<string, unknown> | undefined);
  return auth.mode === "basic";
}

export function applyPathSegmentCredentialToPath(
  path: string,
  secret: string,
  pathPrefix?: string,
): { path: string; applied: boolean } {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const prefix = normalizePathPrefix(pathPrefix) ?? DEFAULT_HTTP_API_PATH_PREFIX;
  const encodedSecret = encodeURIComponent(secret);
  const prefixWithSlash = prefix === "/" ? "/" : `${prefix}/`;

  if (normalizedPath === prefix) {
    return { path: `${prefix}/${encodedSecret}`, applied: true };
  }

  if (normalizedPath.startsWith(`${prefixWithSlash}${encodedSecret}`)) {
    return { path: normalizedPath, applied: true };
  }

  if (normalizedPath.startsWith(prefixWithSlash)) {
    return {
      path: `${prefix}/${encodedSecret}${normalizedPath.slice(prefix.length)}`,
      applied: true,
    };
  }

  return { path: normalizedPath, applied: false };
}

export function httpApiCredentialAuthLabel(mode: HttpApiCredentialAuthMode): string {
  switch (mode) {
    case "basic":
      return "Basic auth";
    case "bearer":
      return "Bearer token";
    case "api-key":
      return "API key header";
    case "query-param":
      return "Query token";
    case "path-segment":
      return "Path token";
    default:
      return mode;
  }
}

export function describeHttpApiCredentialAuth(scopeJson?: Record<string, unknown>): string {
  const auth = getHttpApiCredentialAuth(scopeJson);
  switch (auth.mode) {
    case "api-key":
      return `${httpApiCredentialAuthLabel(auth.mode)} (${auth.headerName ?? DEFAULT_HTTP_API_API_KEY_HEADER})`;
    case "query-param":
      return `${httpApiCredentialAuthLabel(auth.mode)} (${auth.queryParamName ?? DEFAULT_HTTP_API_QUERY_PARAM})`;
    case "path-segment":
      return `${httpApiCredentialAuthLabel(auth.mode)} (${auth.pathPrefix ?? DEFAULT_HTTP_API_PATH_PREFIX})`;
    default:
      return httpApiCredentialAuthLabel(auth.mode);
  }
}
