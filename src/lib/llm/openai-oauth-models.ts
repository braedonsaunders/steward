export const OPENAI_OAUTH_CODEX_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
] as const;

export const DEFAULT_OPENAI_OAUTH_MODEL = OPENAI_OAUTH_CODEX_MODELS[0];

export const OPENAI_OAUTH_CODEX_MODEL_SET = new Set<string>(
  OPENAI_OAUTH_CODEX_MODELS,
);

export const listOpenAIOAuthModels = (): string[] => [
  ...OPENAI_OAUTH_CODEX_MODELS,
];
