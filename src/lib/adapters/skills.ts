import type {
  AdapterLlmToolCall,
  AdapterManifest,
  AdapterToolSkill,
} from "@/lib/adapters/types";

const TOOL_CALL_NAME_MAX = 64;

const DEFAULT_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    device_id: {
      type: "string",
      description: "Target device id (preferred) or a resolvable hostname/IP.",
    },
    input: {
      type: "object",
      description: "Optional tool-specific arguments.",
      additionalProperties: true,
    },
  },
  required: ["device_id"],
  additionalProperties: true,
};

export const DEFAULT_ADAPTER_SKILL_MD_PATH = "SKILL.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolCallIdentifier(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TOOL_CALL_NAME_MAX);

  if (!normalized) {
    return "adapter_tool_call";
  }

  if (/^[a-z]/.test(normalized)) {
    return normalized;
  }

  return `tool_${normalized}`.slice(0, TOOL_CALL_NAME_MAX);
}

function normalizeToolCall(
  skill: Pick<AdapterToolSkill, "id" | "name" | "description">,
  toolCall: unknown,
): AdapterLlmToolCall {
  const defaultName = toToolCallIdentifier(skill.id || skill.name || "adapter_tool_call");
  const defaultDescription = skill.description?.trim() || skill.name || skill.id;

  if (!isRecord(toolCall)) {
    return {
      name: defaultName,
      description: defaultDescription,
      parameters: { ...DEFAULT_TOOL_PARAMETERS },
    };
  }

  const nameRaw = typeof toolCall.name === "string" ? toolCall.name : defaultName;
  const descriptionRaw = typeof toolCall.description === "string"
    ? toolCall.description
    : defaultDescription;
  const parametersRaw = isRecord(toolCall.parameters) ? toolCall.parameters : DEFAULT_TOOL_PARAMETERS;

  return {
    name: toToolCallIdentifier(nameRaw),
    description: descriptionRaw.trim() || defaultDescription,
    parameters: parametersRaw,
  };
}

export function normalizeToolSkill(skill: AdapterToolSkill): AdapterToolSkill {
  return {
    ...skill,
    toolCall: normalizeToolCall(skill, skill.toolCall),
  };
}

export function normalizeToolSkills(skills: AdapterToolSkill[] | undefined): AdapterToolSkill[] {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.map((skill) => normalizeToolSkill(skill));
}

export function defaultToolSkillMarkdownPath(skillId: string): string {
  const slug = skillId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `skills/${slug || "tool-skill"}.md`;
}

function formatOperationKinds(skill: AdapterToolSkill): string {
  if (!skill.operationKinds || skill.operationKinds.length === 0) {
    return "not declared";
  }
  return skill.operationKinds.join(", ");
}

export function buildAdapterSkillMarkdown(manifest: AdapterManifest): string {
  const provides = (manifest.provides ?? []).join(", ") || "none";
  return [
    `# ${manifest.name}`,
    "",
    "## Purpose",
    manifest.description || "No description provided.",
    "",
    "## Capability Surface",
    `Provides: ${provides}`,
    "",
    "## Operating Guidance",
    "Prefer deterministic actions first, then escalate to mutating actions only when policy allows.",
    "For any mutating workflow, include a preflight, verification, and rollback-aware path.",
    "",
  ].join("\n");
}

export function buildToolSkillMarkdown(skill: AdapterToolSkill): string {
  const toolCall = normalizeToolCall(skill, skill.toolCall);
  return [
    `# ${skill.name}`,
    "",
    "## Purpose",
    skill.description,
    "",
    "## Formal Tool Call",
    "```json",
    JSON.stringify(toolCall, null, 2),
    "```",
    "",
    "## Operation Kinds",
    formatOperationKinds(skill),
    "",
    "## Guidance",
    "Use this call when the user asks for operational work this skill owns.",
    "Confirm the target device identity before execution and avoid assumptions.",
    "",
  ].join("\n");
}

