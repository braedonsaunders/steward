import { stateStore } from "@/lib/state/store";
import { adapterRegistry } from "@/lib/adapters/registry";

function trimForPrompt(value: string | undefined, maxChars = 1_200): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}

export interface AssistantContext {
  generatedAt: string;
  overview: {
    deviceCount: number;
    online: number;
    offline: number;
    incidentsOpen: number;
    recommendationsOpen: number;
  };
  devices: Array<{
    id: string;
    name: string;
    ip: string;
    type: string;
    status: string;
    services: string[];
  }>;
  recentIncidents: Array<{
    id: string;
    title: string;
    severity: string;
    status: string;
    deviceIds: string[];
  }>;
  adapterSkillGuides: Array<{
    adapterId: string;
    adapterName: string;
    markdown: string;
  }>;
  adapterToolSkills: Array<{
    adapterId: string;
    adapterName: string;
    skillId: string;
    skillName: string;
    description: string;
    category?: string;
    toolCallName: string;
    toolCallDescription: string;
    toolCallParameters: Record<string, unknown>;
    markdown?: string;
  }>;
}

export const buildAssistantContext = async (): Promise<AssistantContext> => {
  const state = await stateStore.getState();
  await adapterRegistry.initialize();
  const adapters = adapterRegistry.getAdapterRecords();

  const online = state.devices.filter((device) => device.status === "online").length;
  const offline = state.devices.filter((device) => device.status === "offline").length;
  const enabledAdapters = adapters.filter((adapter) => adapter.enabled && adapter.status === "loaded");

  return {
    generatedAt: new Date().toISOString(),
    overview: {
      deviceCount: state.devices.length,
      online,
      offline,
      incidentsOpen: state.incidents.filter((incident) => incident.status !== "resolved").length,
      recommendationsOpen: state.recommendations.filter((recommendation) => !recommendation.dismissed)
        .length,
    },
    devices: state.devices.slice(0, 50).map((device) => ({
      id: device.id,
      name: device.name,
      ip: device.ip,
      type: device.type,
      status: device.status,
      services: device.services.map((service) => `${service.name}:${service.port}`),
    })),
    recentIncidents: state.incidents.slice(0, 20).map((incident) => ({
      id: incident.id,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      deviceIds: incident.deviceIds,
    })),
    adapterSkillGuides: enabledAdapters
      .map((adapter) => {
        const markdown = trimForPrompt(adapter.skillMd?.content);
        if (!markdown) {
          return undefined;
        }
        return {
          adapterId: adapter.id,
          adapterName: adapter.name,
          markdown,
        };
      })
      .filter((item): item is { adapterId: string; adapterName: string; markdown: string } => Boolean(item))
      .slice(0, 16),
    adapterToolSkills: enabledAdapters
      .flatMap((adapter) =>
        (adapter.toolSkills ?? []).map((skill) => ({
          adapterId: adapter.id,
          adapterName: adapter.name,
          skillId: skill.id,
          skillName: skill.name,
          description: skill.description,
          category: skill.category,
          toolCallName: skill.toolCall?.name ?? skill.id,
          toolCallDescription: skill.toolCall?.description ?? skill.description,
          toolCallParameters: skill.toolCall?.parameters ?? {
            type: "object",
            properties: {},
            additionalProperties: true,
          },
          markdown: trimForPrompt(skill.skillMd?.content, 900),
        })))
      .slice(0, 60),
  };
};
