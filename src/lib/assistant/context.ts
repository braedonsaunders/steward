import { stateStore } from "@/lib/state/store";

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
}

export const buildAssistantContext = async (): Promise<AssistantContext> => {
  const state = await stateStore.getState();

  const online = state.devices.filter((device) => device.status === "online").length;
  const offline = state.devices.filter((device) => device.status === "offline").length;

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
  };
};
