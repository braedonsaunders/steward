import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyStateSchemaAndMigrations } from "@/lib/state/db";

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
});
