import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthSettings } from "@/lib/state/types";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface OidcTokens {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface OidcResolvedUser {
  externalId: string;
  usernameHint: string;
  displayName: string;
  email?: string;
}

export function randomBase64Url(size = 32): string {
  return randomBytes(size).toString("base64url");
}

export function pkceCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  const wellKnownUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(wellKnownUrl, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed (${res.status}).`);
  }
  const payload = await res.json() as Partial<OidcDiscovery>;
  if (
    !payload.authorization_endpoint
    || !payload.token_endpoint
    || !payload.jwks_uri
    || !payload.issuer
  ) {
    throw new Error("OIDC discovery document is missing required fields.");
  }
  return payload as OidcDiscovery;
}

export function buildOidcAuthorizeUrl(input: {
  discovery: OidcDiscovery;
  auth: AuthSettings["oidc"];
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const scopes = (input.auth.scopes || "openid profile email").trim() || "openid profile email";
  const url = new URL(input.discovery.authorization_endpoint);
  url.searchParams.set("client_id", input.auth.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeOidcCode(input: {
  discovery: OidcDiscovery;
  auth: AuthSettings["oidc"];
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientSecret?: string;
}): Promise<OidcTokens> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", input.code);
  params.set("redirect_uri", input.redirectUri);
  params.set("client_id", input.auth.clientId);
  params.set("code_verifier", input.codeVerifier);
  if (input.clientSecret) {
    params.set("client_secret", input.clientSecret);
  }

  const res = await fetch(input.discovery.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OIDC token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  return await res.json() as OidcTokens;
}

export async function verifyOidcIdToken(input: {
  idToken: string;
  discovery: OidcDiscovery;
  clientId: string;
  nonce: string;
}): Promise<JWTPayload> {
  const jwks = createRemoteJWKSet(new URL(input.discovery.jwks_uri));
  const { payload } = await jwtVerify(input.idToken, jwks, {
    issuer: input.discovery.issuer,
    audience: input.clientId,
  });
  if (payload.nonce !== input.nonce) {
    throw new Error("OIDC nonce validation failed.");
  }
  return payload;
}

export async function resolveOidcUser(input: {
  tokens: OidcTokens;
  discovery: OidcDiscovery;
  auth: AuthSettings["oidc"];
  nonce: string;
}): Promise<OidcResolvedUser> {
  if (!input.tokens.id_token) {
    throw new Error("OIDC token response did not include an id_token.");
  }

  const payload = await verifyOidcIdToken({
    idToken: input.tokens.id_token,
    discovery: input.discovery,
    clientId: input.auth.clientId,
    nonce: input.nonce,
  });

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) {
    throw new Error("OIDC id_token missing subject claim.");
  }

  const preferred = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const name = typeof payload.name === "string" ? payload.name : undefined;

  const usernameHint = (preferred || email || sub).split("@")[0] || "user";
  const displayName = name || email || preferred || usernameHint;

  return {
    externalId: sub,
    usernameHint,
    displayName,
    email,
  };
}
