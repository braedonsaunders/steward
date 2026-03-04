import { randomUUID } from "node:crypto";
import { stateStore } from "@/lib/state/store";
import type { Device, GraphEdge, GraphNode } from "@/lib/state/types";

const upsertGraphNode = (nodes: GraphNode[], node: GraphNode): GraphNode[] => {
  const idx = nodes.findIndex((n) => n.id === node.id);
  if (idx === -1) {
    return [...nodes, node];
  }

  const next = [...nodes];
  next[idx] = {
    ...next[idx],
    ...node,
    updatedAt: new Date().toISOString(),
  };
  return next;
};

const upsertGraphEdge = (edges: GraphEdge[], edge: GraphEdge): GraphEdge[] => {
  const idx = edges.findIndex(
    (e) => e.from === edge.from && e.to === edge.to && e.type === edge.type,
  );

  if (idx === -1) {
    return [...edges, edge];
  }

  const next = [...edges];
  next[idx] = {
    ...next[idx],
    properties: {
      ...next[idx].properties,
      ...edge.properties,
    },
    updatedAt: new Date().toISOString(),
  };

  return next;
};

export const graphStore = {
  async attachDevice(device: Device): Promise<void> {
    await stateStore.updateState(async (state) => {
      const node: GraphNode = {
        id: `device:${device.id}`,
        type: "device",
        label: device.name,
        properties: {
          ip: device.ip,
          type: device.type,
          status: device.status,
          role: device.role,
          protocols: device.protocols,
          services: device.services,
        },
        createdAt: device.firstSeenAt,
        updatedAt: device.lastSeenAt,
      };

      state.graph.nodes = upsertGraphNode(state.graph.nodes, node);
      state.graph.edges = upsertGraphEdge(state.graph.edges, {
        id: randomUUID(),
        from: "site:default",
        to: node.id,
        type: "contains",
        properties: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      for (const service of device.services) {
        const serviceNodeId = `service:${device.id}:${service.transport}:${service.port}`;
        const serviceNode: GraphNode = {
          id: serviceNodeId,
          type: "service",
          label: `${service.name}:${service.port}`,
          properties: {
            ...service,
          },
          createdAt: service.lastSeenAt,
          updatedAt: service.lastSeenAt,
        };

        state.graph.nodes = upsertGraphNode(state.graph.nodes, serviceNode);
        state.graph.edges = upsertGraphEdge(state.graph.edges, {
          id: randomUUID(),
          from: node.id,
          to: serviceNodeId,
          type: "runs",
          properties: {
            secure: service.secure,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      return state;
    });
  },

  async addDependency(fromDeviceId: string, toDeviceId: string, reason: string): Promise<void> {
    await stateStore.updateState(async (state) => {
      state.graph.edges = upsertGraphEdge(state.graph.edges, {
        id: randomUUID(),
        from: `device:${fromDeviceId}`,
        to: `device:${toDeviceId}`,
        type: "depends_on",
        properties: { reason },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return state;
    });
  },

  async getDependents(deviceId: string): Promise<string[]> {
    const state = await stateStore.getState();
    const target = `device:${deviceId}`;

    return state.graph.edges
      .filter((edge) => edge.type === "depends_on" && edge.to === target)
      .map((edge) => edge.from.replace(/^device:/, ""));
  },

  async getRecentChanges(hours = 24): Promise<GraphNode[]> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const state = await stateStore.getState();

    return state.graph.nodes.filter((node) => new Date(node.updatedAt).getTime() >= cutoff);
  },
};
