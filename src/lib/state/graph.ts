import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import type { Device, GraphNode } from "@/lib/state/types";

const subnet24 = (ip: string): string | undefined => {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
};

function graphNodeFromRow(row: Record<string, unknown>): GraphNode {
  return {
    id: row.id as string,
    type: row.type as GraphNode["type"],
    label: row.label as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

const upsertNodeStmt = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO graph_nodes (id, type, label, properties, createdAt, updatedAt)
    VALUES (@id, @type, @label, @properties, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      label = excluded.label,
      properties = excluded.properties,
      updatedAt = excluded.updatedAt
  `);

const upsertEdgeStmt = (db: Database.Database) =>
  db.prepare(`
    INSERT INTO graph_edges (id, "from", "to", type, properties, createdAt, updatedAt)
    VALUES (@id, @from, @to, @type, @properties, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      properties = json_patch(graph_edges.properties, excluded.properties),
      updatedAt = excluded.updatedAt
  `);

/**
 * Find an existing edge by (from, to, type) composite key.
 */
function findEdge(
  db: Database.Database,
  from: string,
  to: string,
  type: string,
): { id: string; properties: string } | undefined {
  return db
    .prepare('SELECT id, properties FROM graph_edges WHERE "from" = ? AND "to" = ? AND type = ?')
    .get(from, to, type) as { id: string; properties: string } | undefined;
}

function withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
  const run = () => operation(getDb());
  try {
    return run();
  } catch (error) {
    if (!recoverCorruptDatabase(error, context)) {
      throw error;
    }
    return run();
  }
}

export const graphStore = {
  async attachDevice(device: Device): Promise<void> {
    withDbRecovery("graphStore.attachDevice", (db) => {
      const now = new Date().toISOString();
      const upsertNode = upsertNodeStmt(db);
      const upsertEdge = upsertEdgeStmt(db);

      const tx = db.transaction(() => {
        const workloads = stateStore.getWorkloads(device.id);
        const assurances = stateStore.getAssurances(device.id);
        const accessMethods = stateStore.getAccessMethods(device.id);
        const profiles = stateStore.getDeviceProfiles(device.id);

        // Upsert device node
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

        upsertNode.run({
          id: node.id,
          type: node.type,
          label: node.label,
          properties: JSON.stringify(node.properties),
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
        });

        // Upsert site -> device edge
        const siteEdgeExisting = findEdge(db, "site:default", node.id, "contains");
        const siteEdgeId = siteEdgeExisting?.id ?? randomUUID();
        upsertEdge.run({
          id: siteEdgeId,
          from: "site:default",
          to: node.id,
          type: "contains",
          properties: JSON.stringify({}),
          createdAt: now,
          updatedAt: now,
        });

        const subnet = subnet24(device.ip);
        if (subnet) {
          const subnetNodeId = `subnet:${subnet}`;
          upsertNode.run({
            id: subnetNodeId,
            type: "site",
            label: subnet,
            properties: JSON.stringify({ cidr: subnet }),
            createdAt: now,
            updatedAt: now,
          });

          const siteSubnetEdge = findEdge(db, "site:default", subnetNodeId, "contains");
          upsertEdge.run({
            id: siteSubnetEdge?.id ?? randomUUID(),
            from: "site:default",
            to: subnetNodeId,
            type: "contains",
            properties: JSON.stringify({ kind: "subnet" }),
            createdAt: now,
            updatedAt: now,
          });

          const subnetDeviceEdge = findEdge(db, subnetNodeId, node.id, "contains");
          upsertEdge.run({
            id: subnetDeviceEdge?.id ?? randomUUID(),
            from: subnetNodeId,
            to: node.id,
            type: "contains",
            properties: JSON.stringify({ kind: "member" }),
            createdAt: now,
            updatedAt: now,
          });
        }

        // Upsert observed endpoint nodes and edges.
        for (const service of device.services) {
          const serviceNodeId = `service:${device.id}:${service.transport}:${service.port}`;
          upsertNode.run({
            id: serviceNodeId,
            type: "service",
            label: `${service.name}:${service.port}`,
            properties: JSON.stringify({ ...service }),
            createdAt: service.lastSeenAt,
            updatedAt: service.lastSeenAt,
          });

          const serviceEdgeExisting = findEdge(db, node.id, serviceNodeId, "runs");
          const serviceEdgeId = serviceEdgeExisting?.id ?? randomUUID();
          upsertEdge.run({
            id: serviceEdgeId,
            from: node.id,
            to: serviceNodeId,
            type: "runs",
            properties: JSON.stringify({ secure: service.secure }),
            createdAt: now,
            updatedAt: now,
          });
        }

        // Upsert workload nodes and edges.
        for (const workload of workloads) {
          const workloadNodeId = `workload:${workload.id}`;
          upsertNode.run({
            id: workloadNodeId,
            type: "workload",
            label: workload.displayName,
            properties: JSON.stringify({ ...workload }),
            createdAt: workload.createdAt,
            updatedAt: workload.updatedAt,
          });

          const workloadEdgeExisting = findEdge(db, node.id, workloadNodeId, "hosts");
          upsertEdge.run({
            id: workloadEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: workloadNodeId,
            type: "hosts",
            properties: JSON.stringify({ category: workload.category, criticality: workload.criticality }),
            createdAt: workload.createdAt,
            updatedAt: workload.updatedAt,
          });
        }

        // Upsert access method nodes and edges.
        for (const method of accessMethods) {
          const methodNodeId = `access-method:${method.id}`;
          upsertNode.run({
            id: methodNodeId,
            type: "access_method",
            label: method.title,
            properties: JSON.stringify({ ...method }),
            createdAt: method.createdAt,
            updatedAt: method.updatedAt,
          });

          const methodEdgeExisting = findEdge(db, node.id, methodNodeId, "reachable_via");
          upsertEdge.run({
            id: methodEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: methodNodeId,
            type: "reachable_via",
            properties: JSON.stringify({ selected: method.selected, status: method.status, protocol: method.protocol }),
            createdAt: method.createdAt,
            updatedAt: method.updatedAt,
          });
        }

        // Upsert device profile nodes and edges.
        for (const profile of profiles) {
          const profileNodeId = `device-profile:${profile.id}`;
          upsertNode.run({
            id: profileNodeId,
            type: "device_profile",
            label: profile.name,
            properties: JSON.stringify({ ...profile }),
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          });

          const profileEdgeExisting = findEdge(db, node.id, profileNodeId, "managed_by");
          upsertEdge.run({
            id: profileEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: profileNodeId,
            type: "managed_by",
            properties: JSON.stringify({
              status: profile.status,
              confidence: profile.confidence,
              kind: profile.kind,
            }),
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          });
        }

        // Upsert assurance nodes and edges.
        for (const assurance of assurances) {
          const assuranceNodeId = `assurance:${assurance.id}`;
          upsertNode.run({
            id: assuranceNodeId,
            type: "assurance",
            label: assurance.displayName,
            properties: JSON.stringify({ ...assurance }),
            createdAt: assurance.createdAt,
            updatedAt: assurance.updatedAt,
          });

          const parentNodeId = assurance.workloadId
            ? `workload:${assurance.workloadId}`
            : node.id;
          const assuranceEdgeExisting = findEdge(db, parentNodeId, assuranceNodeId, "validated_by");
          upsertEdge.run({
            id: assuranceEdgeExisting?.id ?? randomUUID(),
            from: parentNodeId,
            to: assuranceNodeId,
            type: "validated_by",
            properties: JSON.stringify({
              criticality: assurance.criticality,
              monitorType: assurance.monitorType,
            }),
            createdAt: assurance.createdAt,
            updatedAt: assurance.updatedAt,
          });

          for (const protocol of assurance.requiredProtocols ?? []) {
            const matchedMethods = accessMethods.filter((method) => method.protocol === protocol || method.kind === protocol);
            for (const method of matchedMethods) {
              const methodNodeId = `access-method:${method.id}`;
              const dependencyEdgeExisting = findEdge(db, assuranceNodeId, methodNodeId, "requires_access");
              upsertEdge.run({
                id: dependencyEdgeExisting?.id ?? randomUUID(),
                from: assuranceNodeId,
                to: methodNodeId,
                type: "requires_access",
                properties: JSON.stringify({ protocol }),
                createdAt: assurance.createdAt,
                updatedAt: assurance.updatedAt,
              });
            }
          }
        }
      });

      tx();
    });
  },

  async addDependency(fromDeviceId: string, toDeviceId: string, reason: string): Promise<void> {
    withDbRecovery("graphStore.addDependency", (db) => {
      const now = new Date().toISOString();
      const from = `device:${fromDeviceId}`;
      const to = `device:${toDeviceId}`;

      const existing = findEdge(db, from, to, "depends_on");
      const edgeId = existing?.id ?? randomUUID();

      upsertEdgeStmt(db).run({
        id: edgeId,
        from,
        to,
        type: "depends_on",
        properties: JSON.stringify({ reason }),
        createdAt: now,
        updatedAt: now,
      });
    });
  },

  async getDependents(deviceId: string): Promise<string[]> {
    return withDbRecovery("graphStore.getDependents", (db) => {
      const target = `device:${deviceId}`;
      const rows = db
        .prepare('SELECT "from" FROM graph_edges WHERE type = \'depends_on\' AND "to" = ?')
        .all(target) as Array<{ from: string }>;
      return rows.map((row) => row.from.replace(/^device:/, ""));
    });
  },

  async getRecentChanges(hours = 24): Promise<GraphNode[]> {
    return withDbRecovery("graphStore.getRecentChanges", (db) => {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const rows = db
        .prepare("SELECT * FROM graph_nodes WHERE updatedAt >= ?")
        .all(cutoff) as Record<string, unknown>[];
      return rows.map(graphNodeFromRow);
    });
  },
};
