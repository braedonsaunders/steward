import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createPkcePair,
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICode,
  exchangeOpenAITokenForApiKey,
  extractOpenAIAccountIdFromTokens,
} from "@/lib/auth/oauth";
import { getProviderConfig } from "@/lib/llm/config";
import { getProviderMeta } from "@/lib/llm/registry";
import { ensureVaultReadyForProviders } from "@/lib/security/vault-gate";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

const CALLBACK_PORT = 1455;
const CALLBACK_TIMEOUT = 5 * 60 * 1000; // 5 minutes

interface OAuthFlowState {
  status: "pending" | "complete" | "error";
  error?: string;
  authorizeUrl?: string;
}

let callbackServer: Server | null = null;
let flowState: OAuthFlowState = { status: "pending" };
let cleanupTimer: NodeJS.Timeout | null = null;

function cleanup() {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }
}

export function getOpenAIOAuthStatus(): OAuthFlowState {
  return { ...flowState };
}

export function isOpenAIOAuthServerRunning(): boolean {
  return callbackServer !== null;
}

/**
 * Start the OpenAI OAuth flow:
 * 1. Generate PKCE pair
 * 2. Start temporary HTTP server on port 1455
 * 3. Return the authorize URL
 *
 * When OpenAI redirects back to localhost:1455/auth/callback:
 * - Exchange the code for tokens
 * - Store tokens in vault
 * - Serve success HTML and shut down
 */
export async function startOpenAIOAuthFlow(): Promise<string> {
  const vaultGate = await ensureVaultReadyForProviders();
  if (!vaultGate.ok) {
    throw new Error(vaultGate.error);
  }

  if (callbackServer) {
    cleanup();
  }

  flowState = { status: "pending" };

  const { verifier, challenge } = createPkcePair();
  const state = verifier; // Use verifier as state for simplicity
  const authorizeUrl = buildOpenAIAuthorizeUrl(state, challenge);

  return new Promise<string>((resolve, reject) => {
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);

        if (url.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          flowState = { status: "error", error };
          res.writeHead(200, { "content-type": "text/html" });
          res.end(errorPage(error));
          setTimeout(cleanup, 1000);
          return;
        }

        if (!code) {
          flowState = { status: "error", error: "No authorization code received" };
          res.writeHead(200, { "content-type": "text/html" });
          res.end(errorPage("No authorization code received"));
          setTimeout(cleanup, 1000);
          return;
        }

        try {
          const callbackVaultGate = await ensureVaultReadyForProviders();
          if (!callbackVaultGate.ok) {
            throw new Error(callbackVaultGate.error);
          }

          const tokens = await exchangeOpenAICode(code, verifier);

          // Always store refresh token for future token refreshes
          if (tokens.refresh_token) {
            await vault.setSecret("llm.oauth.openai.refresh_token", tokens.refresh_token);
          }

          // Strategy 1: Try to exchange id_token for a real API key.
          // This works when the user has an OpenAI Platform org/project.
          let gotApiKey = false;
          if (tokens.id_token) {
            try {
              const apiKey = await exchangeOpenAITokenForApiKey(tokens.id_token);
              await vault.setSecret("llm.api.openai.key", apiKey);
              gotApiKey = true;
            } catch {
              // Token exchange failed — user likely doesn't have a Platform org.
              // Fall through to Strategy 2.
            }
          }

          // Strategy 2: Store the OAuth access token for ChatGPT backend fallback.
          // Store access token, account ID, and expiry (same as oneshot codex.ts)
          if (!gotApiKey) {
            await vault.setSecret("llm.oauth.openai.access_token", tokens.access_token);

            // Store token expiry for refresh logic
            const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
            await vault.setSecret("llm.oauth.openai.expires_at", String(expiresAt));

            // Extract and store ChatGPT account ID from JWT (needed for backend API)
            const accountId = extractOpenAIAccountIdFromTokens(tokens);
            if (accountId) {
              await vault.setSecret("llm.oauth.openai.account_id", accountId);
            }
          }

          // Persist provider config
          const meta = getProviderMeta("openai");
          const existingConfig = await getProviderConfig("openai");
          await stateStore.setProviderConfig({
            provider: "openai",
            enabled: true,
            model: gotApiKey
              ? (existingConfig?.model ?? meta?.defaultModel ?? "gpt-4o-mini")
              : "gpt-5.3-codex",
            // Only set oauthTokenSecret if we're using the OAuth token path
            oauthTokenSecret: gotApiKey ? undefined : "llm.oauth.openai.access_token",
          });

          await stateStore.addAction({
            actor: "user",
            kind: "auth",
            message: gotApiKey
              ? "OpenAI API key obtained via OAuth token exchange"
              : "OpenAI OAuth token obtained (ChatGPT backend mode)",
            context: {
              provider: "openai",
              tokenType: tokens.token_type,
              scope: tokens.scope,
              method: gotApiKey ? "token-exchange" : "chatgpt-backend",
            },
          });

          flowState = { status: "complete" };
          res.writeHead(200, { "content-type": "text/html" });
          res.end(successPage());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          flowState = { status: "error", error: msg };
          res.writeHead(200, { "content-type": "text/html" });
          res.end(errorPage(msg));
        }

        setTimeout(cleanup, 1000);
      },
    );

    server.listen(CALLBACK_PORT, () => {
      callbackServer = server;
      flowState = { status: "pending", authorizeUrl };

      // Auto-timeout
      cleanupTimer = setTimeout(() => {
        flowState = { status: "error", error: "OAuth callback timed out (5 minutes)" };
        cleanup();
      }, CALLBACK_TIMEOUT);

      resolve(authorizeUrl);
    });

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// HTML pages for the callback response
// ---------------------------------------------------------------------------

const pageStyle = `
  font-family: system-ui, -apple-system, sans-serif;
  display: flex; align-items: center; justify-content: center;
  height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;
`;

function successPage(): string {
  return `<!DOCTYPE html><html><body style="${pageStyle}">
    <div style="text-align:center">
      <div style="font-size:48px;margin-bottom:16px">&#10003;</div>
      <h1 style="margin:0 0 8px">Authentication Successful</h1>
      <p style="color:#888">You can close this tab and return to Steward.</p>
    </div>
  </body></html>`;
}

function errorPage(error: string): string {
  return `<!DOCTYPE html><html><body style="${pageStyle}">
    <div style="text-align:center">
      <div style="font-size:48px;margin-bottom:16px">&#10007;</div>
      <h1 style="margin:0 0 8px">Authentication Failed</h1>
      <p style="color:#f87171">${error}</p>
      <p style="color:#888;margin-top:16px">You can close this tab and try again.</p>
    </div>
  </body></html>`;
}
