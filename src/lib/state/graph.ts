import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getLocalIpv4Interfaces, sameSubnet, subnetCidrForIp } from "@/lib/discovery/local";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import type { Device, GraphEdge, GraphNode, SiteRecord } from "@/lib/state/types";

const LOCAL_INTERFACES = getLocalIpv4Interfaces();
const DEFAULT_SITE_ID = "site.local.default";

const subnetForDeviceIp = (ip: string): string | undefined => {
  const localMatch = LOCAL_INTERFACES.find((entry) => sameSubnet(ip, entry.ip, entry.netmask));
  const subnet = subnetCidrForIp(ip, localMatch?.netmask);
  if (!subnet) {
    return undefined;
  }
  return subnet;
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

function stableHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function graphEdgeFromRow(row: Record<string, unknown>): GraphEdge {
  return {
    id: String(row.id),
    from: String(row.from),
    to: String(row.to),
    type: String(row.type),
    properties: JSON.parse(String(row.properties ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
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
      properties = excluded.properties,
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

function siteNodeId(siteId: string): string {
  return `site:${siteId}`;
}

function resolveSite(device?: Device): SiteRecord {
  const fallback: SiteRecord = {
    id: DEFAULT_SITE_ID,
    slug: "local-default",
    name: "Local Site",
    timezone: "America/Toronto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const sites = stateStore.getSites();
  if (sites.length === 0) {
    return fallback;
  }
  if (device?.siteId) {
    return sites.find((site) => site.id === device.siteId) ?? sites[0];
  }
  return sites[0];
}

function findNode(db: Database.Database, id: string): GraphNode | undefined {
  const row = db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? graphNodeFromRow(row) : undefined;
}

function findEdgeById(db: Database.Database, id: string): GraphEdge | undefined {
  const row = db.prepare('SELECT id, "from", "to", type, properties, createdAt, updatedAt FROM graph_edges WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? graphEdgeFromRow(row) : undefined;
}

function recordNodeVersion(db: Database.Database, node: GraphNode): void {
  db.prepare(`
    INSERT INTO graph_node_versions (id, nodeId, label, properties, snapshotHash, versionedAt)
    VALUES (@id, @nodeId, @label, @properties, @snapshotHash, @versionedAt)
  `).run({
    id: randomUUID(),
    nodeId: node.id,
    label: node.label,
    properties: JSON.stringify(node.properties),
    snapshotHash: stableHash({
      type: node.type,
      label: node.label,
      properties: node.properties,
    }),
    versionedAt: node.updatedAt,
  });
}

function recordEdgeVersion(db: Database.Database, edge: GraphEdge): void {
  db.prepare(`
    INSERT INTO graph_edge_versions (id, edgeId, "from", "to", type, properties, snapshotHash, versionedAt)
    VALUES (@id, @edgeId, @from, @to, @type, @properties, @snapshotHash, @versionedAt)
  `).run({
    id: randomUUID(),
    edgeId: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    properties: JSON.stringify(edge.properties),
    snapshotHash: stableHash({
      from: edge.from,
      to: edge.to,
      type: edge.type,
      properties: edge.properties,
    }),
    versionedAt: edge.updatedAt,
  });
}

function upsertVersionedNode(db: Database.Database, node: GraphNode): void {
  const existing = findNode(db, node.id);
  const existingHash = existing
    ? stableHash({ type: existing.type, label: existing.label, properties: existing.properties })
    : null;
  const nextHash = stableHash({ type: node.type, label: node.label, properties: node.properties });

  upsertNodeStmt(db).run({
    id: node.id,
    type: node.type,
    label: node.label,
    properties: JSON.stringify(node.properties),
    createdAt: existing?.createdAt ?? node.createdAt,
    updatedAt: node.updatedAt,
  });

  if (!existing || existingHash !== nextHash) {
    recordNodeVersion(db, {
      ...node,
      createdAt: existing?.createdAt ?? node.createdAt,
    });
  }
}

function upsertVersionedEdge(db: Database.Database, edge: GraphEdge): void {
  const existing = findEdgeById(db, edge.id);
  const existingHash = existing
    ? stableHash({ from: existing.from, to: existing.to, type: existing.type, properties: existing.properties })
    : null;
  const nextHash = stableHash({ from: edge.from, to: edge.to, type: edge.type, properties: edge.properties });

  upsertEdgeStmt(db).run({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    properties: JSON.stringify(edge.properties),
    createdAt: existing?.createdAt ?? edge.createdAt,
    updatedAt: edge.updatedAt,
  });

  if (!existing || existingHash !== nextHash) {
    recordEdgeVersion(db, {
      ...edge,
      createdAt: existing?.createdAt ?? edge.createdAt,
    });
  }
}

export const graphStore = {
  async attachDevice(device: Device): Promise<void> {
    withDbRecovery("graphStore.attachDevice", (db) => {
      const now = new Date().toISOString();
      const site = resolveSite(device);
      const siteId = site.id;
      const siteGraphNodeId = siteNodeId(siteId);

      const tx = db.transaction(() => {
        const workloads = stateStore.getWorkloads(device.id);
        const assurances = stateStore.getAssurances(device.id);
        const accessMethods = stateStore.getAccessMethods(device.id);
        const profiles = stateStore.getDeviceProfiles(device.id);

        upsertVersionedNode(db, {
          id: siteGraphNodeId,
          type: "site",
          label: site.name,
          properties: {
            siteId: site.id,
            slug: site.slug,
            timezone: site.timezone,
          },
          createdAt: site.createdAt,
          updatedAt: site.updatedAt,
        });

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
            siteId,
          },
          createdAt: device.firstSeenAt,
          updatedAt: device.lastSeenAt,
        };

        upsertVersionedNode(db, node);

        // Upsert site -> device edge
        const siteEdgeExisting = findEdge(db, siteGraphNodeId, node.id, "contains");
        const siteEdgeId = siteEdgeExisting?.id ?? randomUUID();
        upsertVersionedEdge(db, {
          id: siteEdgeId,
          from: siteGraphNodeId,
          to: node.id,
          type: "contains",
          properties: { kind: "device" },
          createdAt: now,
          updatedAt: now,
        });

        const subnet = subnetForDeviceIp(device.ip);
        if (subnet) {
          const subnetNodeId = `subnet:${subnet}`;
          upsertVersionedNode(db, {
            id: subnetNodeId,
            type: "site",
            label: subnet,
            properties: { cidr: subnet, siteId },
            createdAt: now,
            updatedAt: now,
          });

          const siteSubnetEdge = findEdge(db, siteGraphNodeId, subnetNodeId, "contains");
          upsertVersionedEdge(db, {
            id: siteSubnetEdge?.id ?? randomUUID(),
            from: siteGraphNodeId,
            to: subnetNodeId,
            type: "contains",
            properties: { kind: "subnet" },
            createdAt: now,
            updatedAt: now,
          });

          const subnetDeviceEdge = findEdge(db, subnetNodeId, node.id, "contains");
          upsertVersionedEdge(db, {
            id: subnetDeviceEdge?.id ?? randomUUID(),
            from: subnetNodeId,
            to: node.id,
            type: "contains",
            properties: { kind: "member" },
            createdAt: now,
            updatedAt: now,
          });
        }

        // Upsert observed endpoint nodes and edges.
        for (const service of device.services) {
          const serviceNodeId = `service:${device.id}:${service.transport}:${service.port}`;
          upsertVersionedNode(db, {
            id: serviceNodeId,
            type: "service",
            label: `${service.name}:${service.port}`,
            properties: { ...service, siteId },
            createdAt: service.lastSeenAt,
            updatedAt: service.lastSeenAt,
          });

          const serviceEdgeExisting = findEdge(db, node.id, serviceNodeId, "runs");
          const serviceEdgeId = serviceEdgeExisting?.id ?? randomUUID();
          upsertVersionedEdge(db, {
            id: serviceEdgeId,
            from: node.id,
            to: serviceNodeId,
            type: "runs",
            properties: { secure: service.secure },
            createdAt: now,
            updatedAt: now,
          });
        }

        // Upsert workload nodes and edges.
        for (const workload of workloads) {
          const workloadNodeId = `workload:${workload.id}`;
          upsertVersionedNode(db, {
            id: workloadNodeId,
            type: "workload",
            label: workload.displayName,
            properties: { ...workload, siteId },
            createdAt: workload.createdAt,
            updatedAt: workload.updatedAt,
          });

          const workloadEdgeExisting = findEdge(db, node.id, workloadNodeId, "hosts");
          upsertVersionedEdge(db, {
            id: workloadEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: workloadNodeId,
            type: "hosts",
            properties: { category: workload.category, criticality: workload.criticality },
            createdAt: workload.createdAt,
            updatedAt: workload.updatedAt,
          });
        }

        // Upsert access method nodes and edges.
        for (const method of accessMethods) {
          const methodNodeId = `access-method:${method.id}`;
          upsertVersionedNode(db, {
            id: methodNodeId,
            type: "access_method",
            label: method.title,
            properties: { ...method, siteId },
            createdAt: method.createdAt,
            updatedAt: method.updatedAt,
          });

          const methodEdgeExisting = findEdge(db, node.id, methodNodeId, "reachable_via");
          upsertVersionedEdge(db, {
            id: methodEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: methodNodeId,
            type: "reachable_via",
            properties: { selected: method.selected, status: method.status, protocol: method.protocol },
            createdAt: method.createdAt,
            updatedAt: method.updatedAt,
          });
        }

        // Upsert device profile nodes and edges.
        for (const profile of profiles) {
          const profileNodeId = `device-profile:${profile.id}`;
          upsertVersionedNode(db, {
            id: profileNodeId,
            type: "device_profile",
            label: profile.name,
            properties: { ...profile, siteId },
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          });

          const profileEdgeExisting = findEdge(db, node.id, profileNodeId, "managed_by");
          upsertVersionedEdge(db, {
            id: profileEdgeExisting?.id ?? randomUUID(),
            from: node.id,
            to: profileNodeId,
            type: "managed_by",
            properties: {
              status: profile.status,
              confidence: profile.confidence,
              kind: profile.kind,
            },
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
          });
        }

        // Upsert assurance nodes and edges.
        for (const assurance of assurances) {
          const assuranceNodeId = `assurance:${assurance.id}`;
          upsertVersionedNode(db, {
            id: assuranceNodeId,
            type: "assurance",
            label: assurance.displayName,
            properties: { ...assurance, siteId },
            createdAt: assurance.createdAt,
            updatedAt: assurance.updatedAt,
          });

          const parentNodeId = assurance.workloadId
            ? `workload:${assurance.workloadId}`
            : node.id;
          const assuranceEdgeExisting = findEdge(db, parentNodeId, assuranceNodeId, "validated_by");
          upsertVersionedEdge(db, {
            id: assuranceEdgeExisting?.id ?? randomUUID(),
            from: parentNodeId,
            to: assuranceNodeId,
            type: "validated_by",
            properties: {
              criticality: assurance.criticality,
              monitorType: assurance.monitorType,
            },
            createdAt: assurance.createdAt,
            updatedAt: assurance.updatedAt,
          });

          for (const protocol of assurance.requiredProtocols ?? []) {
            const matchedMethods = accessMethods.filter((method) => method.protocol === protocol || method.kind === protocol);
            for (const method of matchedMethods) {
              const methodNodeId = `access-method:${method.id}`;
              const dependencyEdgeExisting = findEdge(db, assuranceNodeId, methodNodeId, "requires_access");
              upsertVersionedEdge(db, {
                id: dependencyEdgeExisting?.id ?? randomUUID(),
                from: assuranceNodeId,
                to: methodNodeId,
                type: "requires_access",
                properties: { protocol },
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

      upsertVersionedEdge(db, {
        id: edgeId,
        from,
        to,
        type: "depends_on",
        properties: { reason },
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
      const rows = db.prepare(`
        SELECT gn.*
        FROM graph_nodes gn
        WHERE gn.updatedAt >= ?
           OR gn.id IN (
             SELECT DISTINCT nodeId
             FROM graph_node_versions
             WHERE versionedAt >= ?
           )
      `).all(cutoff, cutoff) as Record<string, unknown>[];
      return rows.map(graphNodeFromRow);
    });
  },
};
