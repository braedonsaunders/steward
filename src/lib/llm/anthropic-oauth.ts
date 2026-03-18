import { refreshAnthropicToken } from "@/lib/auth/oauth";
import { vault } from "@/lib/security/vault";

const ANTHROPIC_ACCESS_TOKEN_SECRET = "llm.oauth.anthropic.access_token";
const ANTHROPIC_REFRESH_TOKEN_SECRET = "llm.oauth.anthropic.refresh_token";
const ANTHROPIC_EXPIRES_AT_SECRET = "llm.oauth.anthropic.expires_at";

export interface PersistableAnthropicOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AnthropicOAuthSession {
  accessToken?: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function loadAnthropicOAuthSession(): Promise<AnthropicOAuthSession> {
  const [accessToken, refreshToken, expiresAtValue] = await Promise.all([
    vault.getSecret(ANTHROPIC_ACCESS_TOKEN_SECRET),
    vault.getSecret(ANTHROPIC_REFRESH_TOKEN_SECRET),
    vault.getSecret(ANTHROPIC_EXPIRES_AT_SECRET),
  ]);

  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtValue ? Number(expiresAtValue) : 0,
  };
}

export async function persistAnthropicOAuthTokens(
  tokens: PersistableAnthropicOAuthTokens,
  options?: { fallbackRefreshToken?: string },
): Promise<AnthropicOAuthSession> {
  const refreshToken = tokens.refresh_token ?? options?.fallbackRefreshToken;
  const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0;

  await vault.setSecret(ANTHROPIC_ACCESS_TOKEN_SECRET, tokens.access_token);

  if (refreshToken) {
    await vault.setSecret(ANTHROPIC_REFRESH_TOKEN_SECRET, refreshToken);
  } else {
    await vault.deleteSecret(ANTHROPIC_REFRESH_TOKEN_SECRET).catch(() => {});
  }

  if (expiresAt > 0) {
    await vault.setSecret(ANTHROPIC_EXPIRES_AT_SECRET, String(expiresAt));
  } else {
    await vault.deleteSecret(ANTHROPIC_EXPIRES_AT_SECRET).catch(() => {});
  }

  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt,
  };
}

export async function clearAnthropicOAuthTokens(): Promise<void> {
  await Promise.all([
    vault.deleteSecret(ANTHROPIC_ACCESS_TOKEN_SECRET).catch(() => {}),
    vault.deleteSecret(ANTHROPIC_REFRESH_TOKEN_SECRET).catch(() => {}),
    vault.deleteSecret(ANTHROPIC_EXPIRES_AT_SECRET).catch(() => {}),
  ]);
}

export async function refreshStoredAnthropicAccessToken(
  refreshToken: string,
): Promise<AnthropicOAuthSession> {
  const tokens = await refreshAnthropicToken(refreshToken);
  return persistAnthropicOAuthTokens(tokens, {
    fallbackRefreshToken: refreshToken,
  });
}

export async function ensureFreshAnthropicOAuthSession(): Promise<AnthropicOAuthSession> {
  const session = await loadAnthropicOAuthSession();

  if (
    session.accessToken &&
    session.refreshToken &&
    session.expiresAt > 0 &&
    Date.now() >= session.expiresAt
  ) {
    try {
      return await refreshStoredAnthropicAccessToken(session.refreshToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Anthropic OAuth session refresh failed: ${message}`);
    }
  }

  return session;
}
