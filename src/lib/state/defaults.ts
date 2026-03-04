import { randomUUID } from "node:crypto";
import type {
  ActionLog,
  LLMProvider,
  ProviderConfig,
  StewardState,
} from "@/lib/state/types";

export const STEWARD_STATE_VERSION = 1;

export const defaultProviderConfigs = (): ProviderConfig[] => [
  {
    provider: "openai",
    enabled: true,
    model: "gpt-4o-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
    oauthTokenSecret: "llm.oauth.openai.access_token",
    oauthClientIdEnvVar: "OPENAI_OAUTH_CLIENT_ID",
    oauthClientSecretEnvVar: "OPENAI_OAUTH_CLIENT_SECRET",
    oauthAuthUrl: process.env.OPENAI_OAUTH_AUTH_URL,
    oauthTokenUrl: process.env.OPENAI_OAUTH_TOKEN_URL,
    oauthScopes: ["model.request"],
  },
  {
    provider: "anthropic",
    enabled: true,
    model: "claude-3-5-sonnet-latest",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    oauthTokenSecret: "llm.oauth.anthropic.access_token",
    oauthClientIdEnvVar: "ANTHROPIC_OAUTH_CLIENT_ID",
    oauthClientSecretEnvVar: "ANTHROPIC_OAUTH_CLIENT_SECRET",
    oauthAuthUrl: process.env.ANTHROPIC_OAUTH_AUTH_URL,
    oauthTokenUrl: process.env.ANTHROPIC_OAUTH_TOKEN_URL,
    oauthScopes: ["api:read", "api:write"],
  },
  {
    provider: "google",
    enabled: true,
    model: "gemini-2.0-flash",
    apiKeyEnvVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    oauthTokenSecret: "llm.oauth.google.access_token",
    oauthClientIdEnvVar: "GOOGLE_OAUTH_CLIENT_ID",
    oauthClientSecretEnvVar: "GOOGLE_OAUTH_CLIENT_SECRET",
    oauthAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
  {
    provider: "openrouter",
    enabled: true,
    model: "openai/gpt-4o-mini",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    oauthTokenSecret: "llm.oauth.openrouter.access_token",
    baseUrl: "https://openrouter.ai/api/v1",
    extraHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": "Steward",
    },
  },
];

const initAction = (): ActionLog => ({
  id: randomUUID(),
  at: new Date().toISOString(),
  actor: "steward",
  kind: "config",
  message: "Steward state initialized",
  context: {},
});

export const defaultState = (): StewardState => ({
  version: STEWARD_STATE_VERSION,
  initializedAt: new Date().toISOString(),
  devices: [],
  baselines: [],
  incidents: [],
  recommendations: [],
  actions: [initAction()],
  graph: {
    nodes: [
      {
        id: "site:default",
        type: "site",
        label: "Local Site",
        properties: {
          name: "default",
          locale: process.env.TZ ?? "America/Toronto",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    edges: [],
  },
  providerConfigs: defaultProviderConfigs(),
  oauthStates: [],
  agentRuns: [],
});

export const providerPriority: LLMProvider[] = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
];
