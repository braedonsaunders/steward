import { createHash, randomBytes } from "node:crypto";
import type { LLMProvider } from "@/lib/state/types";
import { getProviderConfig } from "@/lib/llm/config";

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

  const clientId = config.oauthClientIdEnvVar
    ? process.env[config.oauthClientIdEnvVar]
    : undefined;

  if (!clientId) {
    throw new Error(
      `Missing OAuth client id for ${provider}. Set ${config.oauthClientIdEnvVar ?? "provider oauth client id env var"}.`,
    );
  }

  const clientSecret = config.oauthClientSecretEnvVar
    ? process.env[config.oauthClientSecretEnvVar]
    : undefined;

  return {
    provider,
    authUrl,
    tokenUrl,
    clientId,
    clientSecret,
    scopes: config.oauthScopes ?? [],
  };
};

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
