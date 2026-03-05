import type { AssistantContext } from "@/lib/assistant/context";

function compact(value: unknown, maxChars = 240): string {
  const text = JSON.stringify(value);
  if (!text) {
    return "{}";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function compactMarkdown(value: string | undefined, maxChars = 200): string {
  if (!value) {
    return "";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}...`;
}

export const buildStewardSystemPrompt = (context: AssistantContext): string => {
  return [
    "You are Steward, a practical autonomous IT operations agent for small and mid-size local networks.",
    "Speak in plain language. Be concise, direct, and operational.",
    "When giving recommendations, include why it matters and a concrete next step.",
    "If user asks for an action that can be automated, suggest a safe plan and mention required approval based on autonomy tier.",
    "Never expose secret values. If credentials are needed, ask for onboarding through secure vault.",
    "You can reference the current environment context below.",
    "",
    `Context generated at: ${context.generatedAt}`,
    `Device count: ${context.overview.deviceCount}`,
    `Online: ${context.overview.online}`,
    `Offline: ${context.overview.offline}`,
    `Open incidents: ${context.overview.incidentsOpen}`,
    `Open recommendations: ${context.overview.recommendationsOpen}`,
    "",
    "Known devices:",
    ...context.devices.map(
      (device) =>
        `- ${device.name} (${device.ip}) type=${device.type} status=${device.status} services=${device.services.join(", ") || "none"}`,
    ),
    "",
    "Recent incidents:",
    ...context.recentIncidents.map(
      (incident) =>
        `- [${incident.severity}] ${incident.title} status=${incident.status} devices=${incident.deviceIds.join(",")}`,
    ),
    "",
    "Adapter skill guides (Markdown attachments):",
    ...(context.adapterSkillGuides.length > 0
      ? context.adapterSkillGuides.map(
        (guide) => `- ${guide.adapterName} (${guide.adapterId}): ${compactMarkdown(guide.markdown, 260)}`,
      )
      : ["- none"]),
    "",
    "Available adapter tool skills:",
    ...(context.adapterToolSkills.length > 0
      ? context.adapterToolSkills.map(
        (skill) =>
          `- ${skill.skillName} (${skill.skillId}) adapter=${skill.adapterName} category=${skill.category ?? "general"} ` +
          `tool_call=${skill.toolCallName} schema=${compact(skill.toolCallParameters)}: ${skill.description}` +
          (skill.markdown ? ` guidance="${compactMarkdown(skill.markdown)}"` : ""),
      )
      : ["- none"]),
  ].join("\n");
};
