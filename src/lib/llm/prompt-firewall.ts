const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+all\s+previous\s+instructions/ig,
  /reveal\s+system\s+prompt/ig,
  /you\s+are\s+now\s+in\s+developer\s+mode/ig,
  /<\/?(system|assistant|tool)>/ig,
  /BEGIN[_ -]?PROMPT/ig,
  /END[_ -]?PROMPT/ig,
];

const MAX_TELEMETRY_CHARS = 8_000;

export interface PromptFirewallResult {
  sanitized: string;
  tainted: boolean;
  reasons: string[];
  truncated: boolean;
}

function maskSecrets(input: string): string {
  return input
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s"']+)/ig, "$1[REDACTED]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)([^\s"']+)/ig, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)([^\s"']+)/ig, "$1[REDACTED]");
}

export function applyPromptFirewall(rawTelemetry: string): PromptFirewallResult {
  let sanitized = rawTelemetry;
  const reasons: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      reasons.push(`matched:${pattern.source}`);
      sanitized = sanitized.replace(pattern, "[BLOCKED]");
    }
  }

  sanitized = maskSecrets(sanitized).trim();

  let truncated = false;
  if (sanitized.length > MAX_TELEMETRY_CHARS) {
    sanitized = sanitized.slice(0, MAX_TELEMETRY_CHARS);
    truncated = true;
    reasons.push("truncated");
  }

  return {
    sanitized,
    tainted: reasons.length > 0,
    reasons,
    truncated,
  };
}
