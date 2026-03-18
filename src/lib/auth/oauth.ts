import { createHash, randomBytes } from "node:crypto";
import type { LLMProvider } from "@/lib/state/types";
import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { vault } from "@/lib/security/vault";

interface OAuthSettings {
  provider: LLMProvider;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
}

const base64UrlEncode = (input: Buffer): string =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = base64UrlEncode(randomBytes(32));
  const hash = createHash("sha256").update(verifier).digest();
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
};

export const getProviderOAuthSettings = async (
  provider: LLMProvider,
): Promise<OAuthSettings> => {
  const config = await getProviderConfig(provider);

  if (!config) {
    throw new Error(`Missing provider configuration: ${provider}`);
  }

  const authUrl = config.oauthAuthUrl;
  const tokenUrl = config.oauthTokenUrl;

  if (!authUrl || !tokenUrl) {
    throw new Error(
      `OAuth endpoints are not configured for provider ${provider}. Set oauthAuthUrl and oauthTokenUrl in provider config or env variables.`,
    );
  }

  // Resolve OAuth client ID from vault
  const clientId = await vault.getSecret(`llm.oauth.${provider}.client_id`);

  if (!clientId) {
    throw new Error(
      `Missing OAuth client ID for ${provider}. Add it in Settings > Providers.`,
    );
  }

  // Resolve OAuth client secret from vault (optional for some flows)
  const clientSecret = await vault.getSecret(`llm.oauth.${provider}.client_secret`) ?? undefined;

  return {
    provider,
    authUrl,
    tokenUrl,
    clientId,
    clientSecret,
    scopes: config.oauthScopes ?? [],
  };
};

// ---------------------------------------------------------------------------
// Standard OAuth 2.0 + PKCE (Google)
// ---------------------------------------------------------------------------

export const buildOAuthAuthorizeUrl = (
  settings: OAuthSettings,
  redirectUri: string,
  state: string,
  challenge: string,
): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });

  if (settings.scopes.length > 0) {
    params.set("scope", settings.scopes.join(" "));
  }

  return `${settings.authUrl}?${params.toString()}`;
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
}

export const exchangeOAuthCode = async (params: {
  settings: OAuthSettings;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.settings.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  if (params.settings.clientSecret) {
    body.set("client_secret", params.settings.clientSecret);
  }

  const response = await fetch(params.settings.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
};

// ---------------------------------------------------------------------------
// OpenRouter custom PKCE auth flow
// ---------------------------------------------------------------------------

export const buildOpenRouterAuthorizeUrl = (
  callbackUrl: string,
  challenge: string,
): string => {
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://openrouter.ai/auth?${params.toString()}`;
};

export const exchangeOpenRouterCode = async (
  code: string,
  codeVerifier: string,
): Promise<string> => {
  const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter key exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { key: string };
  return data.key;
};

// ---------------------------------------------------------------------------
// OpenAI OAuth (Codex CLI public client – localhost:1455 callback)
// ---------------------------------------------------------------------------

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPES = "openid profile email offline_access";

export const buildOpenAIAuthorizeUrl = (
  state: string,
  challenge: string,
): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: OPENAI_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${OPENAI_AUTH_URL}?${params.toString()}`;
};

export const exchangeOpenAICode = async (
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OPENAI_REDIRECT_URI,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
};

export const refreshOpenAIToken = async (
  refreshToken: string,
): Promise<TokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_CLIENT_ID,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token refresh failed (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
};

/**
 * Exchange an OpenAI id_token for a real OpenAI Platform API key.
 * Uses the RFC 8693 token-exchange grant. This produces a key that works
 * with the standard api.openai.com endpoints (Chat Completions, Responses, etc.).
 *
 * Requires the user to have an OpenAI Platform organization/project.
 */
export const exchangeOpenAITokenForApiKey = async (
  idToken: string,
): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token: "openai-api-key",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    client_id: OPENAI_CLIENT_ID,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI token→API-key exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
};

/**
 * Parse a JWT payload without verifying the signature.
 * Used to extract claims like chatgpt_account_id from OAuth tokens.
 */
export const parseJwtPayload = (jwt: string): Record<string, unknown> => {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  // Handle both standard base64 and base64url encoding
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const payload = Buffer.from(b64, "base64").toString("utf-8");
  return JSON.parse(payload);
};

/**
 * Extract the ChatGPT account ID from an OpenAI OAuth access token JWT.
 * The Codex CLI uses this as the `ChatGPT-Account-Id` header when routing
 * through the ChatGPT backend API.
 */
export const extractChatGPTAccountId = (accessToken: string): string | undefined => {
  try {
    const payload = parseJwtPayload(accessToken);
    const directId = payload.chatgpt_account_id;
    if (typeof directId === "string" && directId.length > 0) {
      return directId;
    }

    const authClaims = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const nestedId = authClaims?.chatgpt_account_id;
    if (typeof nestedId === "string" && nestedId.length > 0) {
      return nestedId;
    }

    const orgs = payload.organizations;
    if (Array.isArray(orgs)) {
      const firstOrg = orgs[0] as Record<string, unknown> | undefined;
      const orgId = firstOrg?.id;
      if (typeof orgId === "string" && orgId.length > 0) {
        return orgId;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
};

export const extractOpenAIAccountIdFromTokens = (tokens: {
  access_token?: string;
  id_token?: string;
}): string | undefined => {
  if (tokens.id_token) {
    const fromIdToken = extractChatGPTAccountId(tokens.id_token);
    if (fromIdToken) return fromIdToken;
  }
  if (tokens.access_token) {
    const fromAccessToken = extractChatGPTAccountId(tokens.access_token);
    if (fromAccessToken) return fromAccessToken;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Anthropic OAuth (Claude CLI public client – code-paste flow)
// ---------------------------------------------------------------------------

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_MAX_AUTH_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_CONSOLE_AUTH_URL = "https://console.anthropic.com/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
].join(" ");
const ANTHROPIC_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";

export type AnthropicOAuthMode = "max" | "console";

export const buildAnthropicAuthorizeUrl = (
  challenge: string,
  verifier: string,
  mode: AnthropicOAuthMode = "max",
): string => {
  const authorizeUrl = mode === "console"
    ? ANTHROPIC_CONSOLE_AUTH_URL
    : ANTHROPIC_MAX_AUTH_URL;
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return `${authorizeUrl}?${params.toString()}`;
};

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export const exchangeAnthropicCode = async (
  code: string,
  state: string,
  codeVerifier: string,
): Promise<AnthropicTokenResponse> => {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      state,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as AnthropicTokenResponse;
};

export const refreshAnthropicToken = async (
  refreshToken: string,
): Promise<AnthropicTokenResponse> => {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic token refresh failed (${response.status}): ${text}`);
  }

  return (await response.json()) as AnthropicTokenResponse;
};

export const createAnthropicApiKey = async (
  accessToken: string,
): Promise<string> => {
  const response = await fetch(ANTHROPIC_API_KEY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API key creation failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { raw_key: string };
  return data.raw_key;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const isOpenRouterOAuth = (provider: LLMProvider): boolean =>
  provider === "openrouter";

export const isOpenAIOAuth = (provider: LLMProvider): boolean =>
  provider === "openai";

export const isAnthropicOAuth = (provider: LLMProvider): boolean =>
  provider === "anthropic";

export const providerSupportsOAuth = (provider: LLMProvider): boolean => {
  const meta = getProviderMeta(provider);
  return meta?.supportsOAuth === true;
};
