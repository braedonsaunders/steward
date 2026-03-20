import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAuditSchemaAndMigrations,
  applyStateSchemaAndMigrations,
  repairLegacyInvestigationState,
} from "@/lib/state/db";

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tempDbPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "steward-autonomy-"));
  return path.join(directory, "state.db");
}

describe("autonomy migration and restore", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (target) {
        rmSync(path.dirname(target), { recursive: true, force: true });
      }
    }
  });

  it("migrates legacy chat and pack tables to the new autonomy schema", () => {
    const dbPath = tempDbPath();
    cleanupPaths.push(dbPath);
    const database = new Database(dbPath);
    database.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        deviceId TEXT,
        provider TEXT,
        model TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE packs (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'builtin',
        enabled INTEGER NOT NULL DEFAULT 1,
        builtin INTEGER NOT NULL DEFAULT 0,
        trustMode TEXT NOT NULL DEFAULT 'unsigned',
        manifestJson TEXT NOT NULL DEFAULT '{}',
        installedAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);

    applyStateSchemaAndMigrations(database);

    expect(hasColumn(database, "chat_sessions", "missionId")).toBe(true);
    expect(hasColumn(database, "chat_sessions", "gatewayThreadId")).toBe(true);
    expect(hasColumn(database, "packs", "signerId")).toBe(true);
    expect(hasColumn(database, "packs", "verificationStatus")).toBe(true);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pack_signers'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_memories'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'standing_orders'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_delegations'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_plans'").get()).toBeTruthy();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_delivery_events'").get()).toBeTruthy();

    database.close();
  });

  it("restores autonomy state cleanly from a backup copy", () => {
    const dbPath = tempDbPath();
    cleanupPaths.push(dbPath);
    const backupPath = path.join(path.dirname(dbPath), "state.backup.db");
    const database = new Database(dbPath);
    applyStateSchemaAndMigrations(database);
    database.prepare(`
      INSERT INTO subagents (id, slug, name, description, status, scopeJson, autonomyJson, createdAt, updatedAt)
      VALUES ('subagent.test', 'subagent-test', 'Subagent Test', '', 'active', '{}', '{}', '2026-03-17T12:00:00.000Z', '2026-03-17T12:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO missions (
        id, slug, title, summary, kind, status, priority, objective, subagentId,
        cadenceMinutes, autoRun, autoApprove, shadowMode, targetJson, stateJson, createdBy, createdAt, updatedAt
      )
      VALUES (
        'mission.test', 'mission-test', 'Mission Test', '', 'custom', 'active', 'medium', 'Own test state', 'subagent.test',
        60, 1, 0, 0, '{}', '{}', 'steward', '2026-03-17T12:00:00.000Z', '2026-03-17T12:00:00.000Z'
      )
    `).run();
    database.close();

    copyFileSync(dbPath, backupPath);

    const mutated = new Database(dbPath);
    mutated.prepare("DELETE FROM missions WHERE id = 'mission.test'").run();
    mutated.close();

    copyFileSync(backupPath, dbPath);

    const restored = new Database(dbPath);
    const row = restored.prepare("SELECT id, title FROM missions WHERE id = 'mission.test'").get() as { id?: string; title?: string } | undefined;
    expect(row).toEqual({
      id: "mission.test",
      title: "Mission Test",
    });
    restored.close();
  });

  it("repairs orphaned duplicate investigations and purges stale queue entries", () => {
    const stateDbPath = tempDbPath();
    cleanupPaths.push(stateDbPath);
    const auditDbPath = path.join(path.dirname(stateDbPath), "audit.db");

    const stateDatabase = new Database(stateDbPath);
    applyStateSchemaAndMigrations(stateDatabase);
    stateDatabase.prepare("DELETE FROM metadata WHERE key IN (?, ?)").run(
      "migration.investigation_state_cleanup.v1",
      "migration.investigation_queue_cleanup.v1",
    );

    stateDatabase.prepare(`
      INSERT INTO subagents (id, slug, name, description, status, scopeJson, autonomyJson, createdAt, updatedAt)
      VALUES (
        'subagent.availability-operator', 'availability-operator', 'Availability Operator', '', 'active', '{}', '{}',
        '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z'
      )
      ON CONFLICT(id) DO NOTHING
    `).run();

    stateDatabase.prepare(`
      INSERT INTO missions (
        id, slug, title, summary, kind, status, priority, objective, subagentId,
        cadenceMinutes, autoRun, autoApprove, shadowMode, targetJson, stateJson, createdBy, createdAt, updatedAt
      )
      VALUES (
        'mission.availability-overwatch', 'availability-overwatch', 'Availability Overwatch', '', 'availability-guardian', 'active', 'high',
        'Own availability drift.', 'subagent.availability-operator',
        10, 1, 0, 0, '{"selector":{"allDevices":true}}', '{"offlineDeviceIds":["device-1"]}', 'steward',
        '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z'
      )
      ON CONFLICT(id) DO UPDATE SET
        stateJson = excluded.stateJson,
        updatedAt = excluded.updatedAt
    `).run();

    stateDatabase.prepare(`
      INSERT INTO devices (
        id, siteId, name, ip, type, status, autonomyTier, firstSeenAt, lastSeenAt, lastChangedAt, metadata
      )
      VALUES
        ('device-1', 'site.local.default', 'edge-ap', '10.0.0.1', 'access-point', 'offline', 1, '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z', '{}'),
        ('device-2', 'site.local.default', 'edge-switch', '10.0.0.2', 'switch', 'online', 1, '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z', '2026-03-20T12:00:00.000Z', '{}')
    `).run();

    stateDatabase.prepare(`
      INSERT INTO investigations (
        id, missionId, subagentId, parentInvestigationId, title, status, severity, stage, objective, hypothesis, summary,
        sourceType, sourceId, deviceId, evidenceJson, recommendedActionsJson, unresolvedQuestionsJson,
        nextRunAt, lastRunAt, resolution, createdAt, updatedAt
      )
      VALUES
        ('inv-current', NULL, 'subagent.availability-operator', NULL, 'Investigate device-1', 'open', 'warning', 'detect', 'Own availability drift.', NULL, 'device-1 offline', 'device', 'device-1', 'device-1', '{}', '[]', '[]', NULL, NULL, NULL, '2026-03-20T12:00:00.000Z', '2026-03-20T12:05:00.000Z'),
        ('inv-duplicate', NULL, 'subagent.availability-operator', NULL, 'Investigate device-1 again', 'monitoring', 'warning', 'probe', 'Own availability drift.', NULL, 'device-1 still offline', 'device', 'device-1', 'device-1', '{}', '[]', '[]', NULL, NULL, NULL, '2026-03-20T11:00:00.000Z', '2026-03-20T11:05:00.000Z'),
        ('inv-followup', NULL, 'subagent.availability-operator', 'inv-current', 'Escalate device-1', 'open', 'warning', 'detect', 'Own availability drift.', NULL, 'needs escalation', 'device.followup', 'device-1', 'device-1', '{}', '[]', '[]', NULL, NULL, NULL, '2026-03-20T12:06:00.000Z', '2026-03-20T12:06:00.000Z'),
        ('inv-stale', NULL, 'subagent.availability-operator', NULL, 'Investigate device-2', 'open', 'warning', 'detect', 'Own availability drift.', NULL, 'device-2 offline', 'device', 'device-2', 'device-2', '{}', '[]', '[]', NULL, NULL, NULL, '2026-03-20T10:00:00.000Z', '2026-03-20T10:00:00.000Z')
    `).run();

    const repairResult = repairLegacyInvestigationState(stateDatabase);
    expect(repairResult).toEqual({
      canonicalized: 1,
      closedDuplicates: 1,
      closedFollowups: 1,
      closedStale: 1,
      linksCreated: 2,
    });

    const openRows = stateDatabase.prepare(`
      SELECT id, missionId, subagentId, status
      FROM investigations
      WHERE status IN ('open', 'monitoring')
      ORDER BY id ASC
    `).all() as Array<{ id: string; missionId: string | null; subagentId: string | null; status: string }>;
    expect(openRows).toEqual([
      {
        id: "inv-current",
        missionId: "mission.availability-overwatch",
        subagentId: "subagent.availability-operator",
        status: "open",
      },
    ]);

    const missionLinks = stateDatabase.prepare(`
      SELECT missionId, resourceType, resourceId
      FROM mission_links
      ORDER BY resourceType ASC, resourceId ASC
    `).all() as Array<{ missionId: string; resourceType: string; resourceId: string }>;
    expect(missionLinks).toEqual([
      {
        missionId: "mission.availability-overwatch",
        resourceType: "device",
        resourceId: "device-1",
      },
      {
        missionId: "mission.availability-overwatch",
        resourceType: "investigation",
        resourceId: "inv-current",
      },
    ]);

    const auditDatabase = new Database(auditDbPath);
    applyAuditSchemaAndMigrations(auditDatabase, { stateDatabase });
    stateDatabase.prepare("DELETE FROM metadata WHERE key = ?").run("migration.investigation_queue_cleanup.v1");
    auditDatabase.prepare(`
      INSERT INTO durable_jobs (id, kind, payload, status, attempts, idempotencyKey, runAfter, createdAt, updatedAt, lastError)
      VALUES
        ('job-open', 'investigation.step', '{"investigationId":"inv-current"}', 'pending', 0, 'investigation.step:inv-current', '2026-03-20T12:07:00.000Z', '2026-03-20T12:07:00.000Z', '2026-03-20T12:07:00.000Z', NULL),
        ('job-closed', 'investigation.step', '{"investigationId":"inv-duplicate"}', 'pending', 0, 'investigation.step:inv-duplicate', '2026-03-20T12:07:00.000Z', '2026-03-20T12:07:00.000Z', '2026-03-20T12:07:00.000Z', NULL)
    `).run();

    applyAuditSchemaAndMigrations(auditDatabase, { stateDatabase });

    const durableJobs = auditDatabase.prepare(`
      SELECT id, idempotencyKey
      FROM durable_jobs
      WHERE kind = 'investigation.step'
      ORDER BY id ASC
    `).all() as Array<{ id: string; idempotencyKey: string | null }>;
    expect(durableJobs).toEqual([
      {
        id: "job-open",
        idempotencyKey: "investigation.step:inv-current",
      },
    ]);

    auditDatabase.close();
    stateDatabase.close();
  });
});
