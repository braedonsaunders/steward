export const STEWARD_API_TOKEN_STORAGE_KEY = "steward.apiToken";
export const STEWARD_API_TOKEN_QUERY_PARAM = "steward_token";

export function getStoredApiToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = window.localStorage.getItem(STEWARD_API_TOKEN_STORAGE_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function persistApiToken(token: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!token) {
    window.localStorage.removeItem(STEWARD_API_TOKEN_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STEWARD_API_TOKEN_STORAGE_KEY, token);
}

export function withClientApiToken(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  const token = getStoredApiToken();
  if (token && !headers.has("authorization") && !headers.has("x-steward-token")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return {
    ...init,
    headers,
  };
}

export function withApiTokenQuery(url: string): string {
  const token = getStoredApiToken();
  if (!token) {
    return url;
  }
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set(STEWARD_API_TOKEN_QUERY_PARAM, token);
  return `${parsed.pathname}${parsed.search}`;
}
