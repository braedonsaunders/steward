import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";
import type { Device, GraphNode } from "@/lib/state/types";

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

        // Upsert service nodes and edges
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
