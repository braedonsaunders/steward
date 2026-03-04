import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

const DATA_DIR = process.env.STEWARD_DATA_DIR ?? path.join(process.cwd(), ".steward");
const DB_PATH = path.join(DATA_DIR, "steward.db");
const CORRUPT_ARCHIVE_DIR = path.join(DATA_DIR, "corrupt-db");

let db: Database.Database | null = null;
let recovering = false;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      ip            TEXT NOT NULL,
      mac           TEXT,
      hostname      TEXT,
      vendor        TEXT,
      os            TEXT,
      role          TEXT,
      type          TEXT NOT NULL,
      status        TEXT NOT NULL,
      autonomyTier  INTEGER NOT NULL,
      tags          TEXT NOT NULL DEFAULT '[]',
      protocols     TEXT NOT NULL DEFAULT '[]',
      services      TEXT NOT NULL DEFAULT '[]',
      firstSeenAt   TEXT NOT NULL,
      lastSeenAt    TEXT NOT NULL,
      lastChangedAt TEXT NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS device_baselines (
      deviceId      TEXT PRIMARY KEY,
      avgLatencyMs  REAL NOT NULL,
      maxLatencyMs  REAL NOT NULL,
      minLatencyMs  REAL NOT NULL,
      samples       INTEGER NOT NULL,
      lastUpdatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      summary         TEXT NOT NULL,
      severity        TEXT NOT NULL,
      deviceIds       TEXT NOT NULL DEFAULT '[]',
      status          TEXT NOT NULL,
      detectedAt      TEXT NOT NULL,
      updatedAt       TEXT NOT NULL,
      timeline        TEXT NOT NULL DEFAULT '[]',
      diagnosis       TEXT,
      remediationPlan TEXT,
      autoRemediated  INTEGER NOT NULL DEFAULT 0,
      metadata        TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      rationale        TEXT NOT NULL,
      impact           TEXT NOT NULL,
      priority         TEXT NOT NULL,
      relatedDeviceIds TEXT NOT NULL DEFAULT '[]',
      createdAt        TEXT NOT NULL,
      dismissed        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS actions (
      id      TEXT PRIMARY KEY,
      at      TEXT NOT NULL,
      actor   TEXT NOT NULL,
      kind    TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      label      TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id         TEXT PRIMARY KEY,
      "from"     TEXT NOT NULL,
      "to"       TEXT NOT NULL,
      type       TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      provider             TEXT PRIMARY KEY,
      enabled              INTEGER NOT NULL DEFAULT 1,
      model                TEXT NOT NULL,
      apiKeyEnvVar         TEXT,
      oauthTokenSecret     TEXT,
      oauthClientIdEnvVar  TEXT,
      oauthClientSecretEnvVar TEXT,
      oauthAuthUrl         TEXT,
      oauthTokenUrl        TEXT,
      oauthScopes          TEXT,
      baseUrl              TEXT,
      extraHeaders         TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      id           TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      redirectUri  TEXT NOT NULL,
      codeVerifier TEXT NOT NULL,
      createdAt    TEXT NOT NULL,
      expiresAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id          TEXT PRIMARY KEY,
      startedAt   TEXT NOT NULL,
      completedAt TEXT,
      outcome     TEXT NOT NULL,
      summary     TEXT NOT NULL,
      details     TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // Indexes for frequently queried columns
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
    CREATE INDEX IF NOT EXISTS idx_actions_at ON actions(at);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges("from");
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges("to");
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_updatedAt ON graph_nodes(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_startedAt ON agent_runs(startedAt);
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expiresAt ON oauth_states(expiresAt);
  `);
}

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    createSchema(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      // no-op
    }
    db = null;
    throw error;
  }

  return db;
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isSqliteCorruptionError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";

  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }

  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("database disk image is malformed") ||
    message.includes("file is not a database")
  );
}

function closeDbQuietly(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // no-op
  } finally {
    db = null;
  }
}

function moveIfExists(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return;
  try {
    renameSync(sourcePath, targetPath);
  } catch (error) {
    console.error(`[state-db] Could not archive ${sourcePath}`, error);
  }
}

export function recoverCorruptDatabase(error: unknown, context: string): boolean {
  if (!isSqliteCorruptionError(error)) {
    return false;
  }

  if (recovering) {
    return true;
  }

  recovering = true;
  try {
    closeDbQuietly();
    mkdirSync(CORRUPT_ARCHIVE_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.join(CORRUPT_ARCHIVE_DIR, `steward-${stamp}`);

    moveIfExists(DB_PATH, `${base}.db`);
    moveIfExists(`${DB_PATH}-wal`, `${base}.db-wal`);
    moveIfExists(`${DB_PATH}-shm`, `${base}.db-shm`);

    // Recreate an empty database + schema immediately.
    getDb();

    console.error(`[state-db] Recovered from SQLite corruption in ${context}. Archived files at ${base}.*`);
    return true;
  } catch (recoveryError) {
    console.error("[state-db] Failed to recover corrupt SQLite database", recoveryError);
    throw recoveryError;
  } finally {
    recovering = false;
  }
}
