import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

const STANDALONE_PATH_SEGMENT = `${path.sep}.next${path.sep}standalone`;

function resolveDataDir(): string {
  const cwd = path.resolve(process.cwd());
  const standaloneIdx = cwd.lastIndexOf(STANDALONE_PATH_SEGMENT);

  if (standaloneIdx === -1) {
    return path.join(cwd, ".steward");
  }

  const repoRoot = cwd.slice(0, standaloneIdx);
  if (!repoRoot) {
    return path.join(cwd, ".steward");
  }

  return path.join(repoRoot, ".steward");
}

const DATA_DIR = resolveDataDir();
const STATE_DB_PATH = path.join(DATA_DIR, "steward_state.db");
const AUDIT_DB_PATH = path.join(DATA_DIR, "steward_audit.db");
const CORRUPT_ARCHIVE_DIR = path.join(DATA_DIR, "corrupt-db");

let stateDb: Database.Database | null = null;
let auditDb: Database.Database | null = null;
let recovering = false;

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (hasColumn(database, table, column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_history (
      id            TEXT PRIMARY KEY,
      domain        TEXT NOT NULL,
      version       INTEGER NOT NULL,
      effectiveFrom TEXT NOT NULL,
      payload       TEXT NOT NULL DEFAULT '{}',
      actor         TEXT NOT NULL,
      createdAt     TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS policy_rules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      actionClasses     TEXT NOT NULL DEFAULT '[]',
      autonomyTiers     TEXT NOT NULL DEFAULT '[]',
      environmentLabels TEXT NOT NULL DEFAULT '[]',
      deviceTypes       TEXT NOT NULL DEFAULT '[]',
      decision          TEXT NOT NULL,
      priority          INTEGER NOT NULL DEFAULT 100,
      enabled           INTEGER NOT NULL DEFAULT 1,
      createdAt         TEXT NOT NULL,
      updatedAt         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      deviceIds       TEXT NOT NULL DEFAULT '[]',
      cronStart       TEXT NOT NULL,
      durationMinutes INTEGER NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      createdAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playbook_runs (
      id                 TEXT PRIMARY KEY,
      playbookId         TEXT NOT NULL,
      family             TEXT NOT NULL,
      name               TEXT NOT NULL,
      deviceId           TEXT NOT NULL,
      incidentId         TEXT,
      actionClass        TEXT NOT NULL,
      status             TEXT NOT NULL,
      policyEvaluation   TEXT NOT NULL DEFAULT '{}',
      steps              TEXT NOT NULL DEFAULT '[]',
      verificationSteps  TEXT NOT NULL DEFAULT '[]',
      rollbackSteps      TEXT NOT NULL DEFAULT '[]',
      evidence           TEXT NOT NULL DEFAULT '{}',
      createdAt          TEXT NOT NULL,
      startedAt          TEXT,
      completedAt        TEXT,
      approvedBy         TEXT,
      approvedAt         TEXT,
      deniedBy           TEXT,
      deniedAt           TEXT,
      denialReason       TEXT,
      expiresAt          TEXT,
      failureCount       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_digests (
      id           TEXT PRIMARY KEY,
      generatedAt  TEXT NOT NULL,
      periodStart  TEXT NOT NULL,
      periodEnd    TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '{}'
    );

    DROP TABLE IF EXISTS plugins;

    CREATE TABLE IF NOT EXISTS adapters (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL DEFAULT 'file',
      dirName     TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      version     TEXT NOT NULL DEFAULT '0.0.0',
      author      TEXT NOT NULL DEFAULT '',
      docsUrl     TEXT,
      provides    TEXT NOT NULL DEFAULT '[]',
      manifestJson TEXT NOT NULL DEFAULT '{}',
      configSchema TEXT NOT NULL DEFAULT '[]',
      config       TEXT NOT NULL DEFAULT '{}',
      toolSkills   TEXT NOT NULL DEFAULT '[]',
      toolConfig   TEXT NOT NULL DEFAULT '{}',
      enabled     INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'disabled',
      error       TEXT,
      installedAt TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      deviceId  TEXT REFERENCES devices(id) ON DELETE SET NULL,
      provider  TEXT,
      model     TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id        TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role      TEXT NOT NULL,
      content   TEXT NOT NULL,
      provider  TEXT,
      error     INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discovery_observations (
      id           TEXT PRIMARY KEY,
      ip           TEXT NOT NULL,
      deviceId     TEXT REFERENCES devices(id) ON DELETE SET NULL,
      source       TEXT NOT NULL,
      evidenceType TEXT NOT NULL,
      confidence   REAL NOT NULL,
      observedAt   TEXT NOT NULL,
      expiresAt    TEXT NOT NULL,
      details      TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS adoption_runs (
      id          TEXT PRIMARY KEY,
      deviceId    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      status      TEXT NOT NULL,
      stage       TEXT NOT NULL,
      profileJson TEXT NOT NULL DEFAULT '{}',
      summary     TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adoption_questions (
      id         TEXT PRIMARY KEY,
      runId      TEXT NOT NULL REFERENCES adoption_runs(id) ON DELETE CASCADE,
      deviceId   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      questionKey TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      optionsJson TEXT NOT NULL DEFAULT '[]',
      required   INTEGER NOT NULL DEFAULT 1,
      answerJson TEXT,
      answeredAt TEXT,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_credentials (
      id              TEXT PRIMARY KEY,
      deviceId        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      protocol        TEXT NOT NULL,
      adapterId       TEXT,
      vaultSecretRef  TEXT NOT NULL,
      accountLabel    TEXT,
      scopeJson       TEXT NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL,
      lastValidatedAt TEXT,
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_adapter_bindings (
      id         TEXT PRIMARY KEY,
      deviceId   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      adapterId  TEXT NOT NULL,
      protocol   TEXT NOT NULL,
      score      REAL NOT NULL DEFAULT 0,
      selected   INTEGER NOT NULL DEFAULT 0,
      reason     TEXT NOT NULL DEFAULT '',
      configJson TEXT NOT NULL DEFAULT '{}',
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_contracts (
      id              TEXT PRIMARY KEY,
      deviceId        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      serviceKey      TEXT NOT NULL,
      displayName     TEXT NOT NULL,
      criticality     TEXT NOT NULL,
      desiredState    TEXT NOT NULL DEFAULT 'running',
      checkIntervalSec INTEGER NOT NULL DEFAULT 60,
      policyJson      TEXT NOT NULL DEFAULT '{}',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_findings (
      id          TEXT PRIMARY KEY,
      deviceId    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      dedupeKey   TEXT NOT NULL,
      findingType TEXT NOT NULL,
      severity    TEXT NOT NULL,
      title       TEXT NOT NULL,
      summary     TEXT NOT NULL,
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'open',
      firstSeenAt TEXT NOT NULL,
      lastSeenAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_users (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL UNIQUE,
      displayName  TEXT NOT NULL,
      passwordHash TEXT,
      role         TEXT NOT NULL,
      provider     TEXT NOT NULL DEFAULT 'local',
      externalId   TEXT,
      disabled     INTEGER NOT NULL DEFAULT 0,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL,
      lastLoginAt  TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_provider_external
      ON auth_users(provider, externalId)
      WHERE externalId IS NOT NULL;

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id         TEXT PRIMARY KEY,
      userId     TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      tokenHash  TEXT NOT NULL UNIQUE,
      createdAt  TEXT NOT NULL,
      expiresAt  TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      ip         TEXT,
      userAgent  TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_oidc_states (
      id           TEXT PRIMARY KEY,
      codeVerifier TEXT NOT NULL,
      nonce        TEXT NOT NULL,
      redirectUri  TEXT NOT NULL,
      createdAt    TEXT NOT NULL,
      expiresAt    TEXT NOT NULL
    );
  `);

  // Migrate columns before creating indexes that reference them
  ensureColumn(database, "chat_sessions", "deviceId", "TEXT REFERENCES devices(id) ON DELETE SET NULL");
  ensureColumn(database, "devices", "secondaryIps", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "adapters", "source", "TEXT NOT NULL DEFAULT 'file'");
  ensureColumn(database, "adapters", "docsUrl", "TEXT");
  ensureColumn(database, "adapters", "manifestJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "adapters", "configSchema", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "adapters", "config", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "adapters", "toolSkills", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "adapters", "toolConfig", "TEXT NOT NULL DEFAULT '{}'");

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
    CREATE INDEX IF NOT EXISTS idx_policy_rules_priority ON policy_rules(priority);
    CREATE INDEX IF NOT EXISTS idx_policy_rules_enabled ON policy_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_status ON playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_deviceId ON playbook_runs(deviceId);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_createdAt ON playbook_runs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_daily_digests_generatedAt ON daily_digests(generatedAt);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updatedAt ON chat_sessions(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_deviceId ON chat_sessions(deviceId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_sessionId ON chat_messages(sessionId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_createdAt ON chat_messages(createdAt);
    CREATE INDEX IF NOT EXISTS idx_adapters_source ON adapters(source);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_ip ON discovery_observations(ip);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_observedAt ON discovery_observations(observedAt);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_expiresAt ON discovery_observations(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_deviceId ON discovery_observations(deviceId);
    CREATE INDEX IF NOT EXISTS idx_adoption_runs_deviceId ON adoption_runs(deviceId);
    CREATE INDEX IF NOT EXISTS idx_adoption_runs_status ON adoption_runs(status);
    CREATE INDEX IF NOT EXISTS idx_adoption_runs_updatedAt ON adoption_runs(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_adoption_questions_runId ON adoption_questions(runId);
    CREATE INDEX IF NOT EXISTS idx_adoption_questions_deviceId ON adoption_questions(deviceId);
    CREATE INDEX IF NOT EXISTS idx_adoption_questions_answeredAt ON adoption_questions(answeredAt);
    CREATE INDEX IF NOT EXISTS idx_device_credentials_device_protocol_adapter
      ON device_credentials(deviceId, protocol, adapterId);
    CREATE INDEX IF NOT EXISTS idx_device_credentials_status ON device_credentials(status);
    CREATE INDEX IF NOT EXISTS idx_device_adapter_bindings_device_protocol
      ON device_adapter_bindings(deviceId, protocol);
    CREATE INDEX IF NOT EXISTS idx_device_adapter_bindings_selected
      ON device_adapter_bindings(deviceId, selected);
    CREATE INDEX IF NOT EXISTS idx_service_contracts_deviceId ON service_contracts(deviceId);
    CREATE INDEX IF NOT EXISTS idx_device_findings_device_status ON device_findings(deviceId, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_findings_dedupe_key
      ON device_findings(deviceId, dedupeKey);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_userId ON auth_sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiresAt ON auth_sessions(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_auth_users_role ON auth_users(role);
    CREATE INDEX IF NOT EXISTS idx_auth_oidc_states_expiresAt ON auth_oidc_states(expiresAt);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_history_domain_version ON settings_history(domain, version);
    CREATE INDEX IF NOT EXISTS idx_settings_history_domain_effectiveFrom ON settings_history(domain, effectiveFrom DESC, createdAt DESC);
  `);

  // OUI vendor lookup tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS oui_prefixes (
      prefix TEXT PRIMARY KEY,
      vendor TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oui_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getDb(): Database.Database {
  if (stateDb) return stateDb;

  mkdirSync(DATA_DIR, { recursive: true });
  stateDb = new Database(STATE_DB_PATH);
  try {
    stateDb.pragma("journal_mode = WAL");
    stateDb.pragma("foreign_keys = ON");
    createSchema(stateDb);
  } catch (error) {
    try {
      stateDb.close();
    } catch {
      // no-op
    }
    stateDb = null;
    throw error;
  }

  return stateDb;
}

function createAuditSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id             TEXT PRIMARY KEY,
      at             TEXT NOT NULL,
      actor          TEXT NOT NULL,
      kind           TEXT NOT NULL,
      message        TEXT NOT NULL,
      context        TEXT NOT NULL DEFAULT '{}',
      idempotencyKey TEXT,
      createdAt      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS durable_jobs (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      payload        TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      attempts       INTEGER NOT NULL DEFAULT 0,
      idempotencyKey TEXT UNIQUE,
      runAfter       TEXT NOT NULL,
      createdAt      TEXT NOT NULL,
      updatedAt      TEXT NOT NULL,
      lastError      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_kind ON audit_events(kind);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_status ON durable_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_runAfter ON durable_jobs(runAfter);
  `);
}

export function getAuditDb(): Database.Database {
  if (auditDb) return auditDb;

  mkdirSync(DATA_DIR, { recursive: true });
  auditDb = new Database(AUDIT_DB_PATH);
  try {
    auditDb.pragma("journal_mode = WAL");
    auditDb.pragma("foreign_keys = ON");
    createAuditSchema(auditDb);
  } catch (error) {
    try {
      auditDb.close();
    } catch {
      // no-op
    }
    auditDb = null;
    throw error;
  }

  return auditDb;
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function getDbPath(): string {
  return STATE_DB_PATH;
}

export function getAuditDbPath(): string {
  return AUDIT_DB_PATH;
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
  if (!stateDb) return;
  try {
    stateDb.close();
  } catch {
    // no-op
  } finally {
    stateDb = null;
  }
}

function closeAuditDbQuietly(): void {
  if (!auditDb) return;
  try {
    auditDb.close();
  } catch {
    // no-op
  } finally {
    auditDb = null;
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
    closeAuditDbQuietly();
    mkdirSync(CORRUPT_ARCHIVE_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const stateBase = path.join(CORRUPT_ARCHIVE_DIR, `steward-state-${stamp}`);

    moveIfExists(STATE_DB_PATH, `${stateBase}.db`);
    moveIfExists(`${STATE_DB_PATH}-wal`, `${stateBase}.db-wal`);
    moveIfExists(`${STATE_DB_PATH}-shm`, `${stateBase}.db-shm`);

    // Recreate an empty database + schema immediately.
    getDb();

    console.error(`[state-db] Recovered from SQLite corruption in ${context}. Archived files at ${stateBase}.*`);
    return true;
  } catch (recoveryError) {
    console.error("[state-db] Failed to recover corrupt SQLite database", recoveryError);
    throw recoveryError;
  } finally {
    recovering = false;
  }
}

export function recoverCorruptAuditDatabase(error: unknown, context: string): boolean {
  if (!isSqliteCorruptionError(error)) {
    return false;
  }

  if (recovering) {
    return true;
  }

  recovering = true;
  try {
    closeAuditDbQuietly();
    mkdirSync(CORRUPT_ARCHIVE_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auditBase = path.join(CORRUPT_ARCHIVE_DIR, `steward-audit-${stamp}`);

    moveIfExists(AUDIT_DB_PATH, `${auditBase}.db`);
    moveIfExists(`${AUDIT_DB_PATH}-wal`, `${auditBase}.db-wal`);
    moveIfExists(`${AUDIT_DB_PATH}-shm`, `${auditBase}.db-shm`);

    getAuditDb();

    console.error(`[audit-db] Recovered from SQLite corruption in ${context}. Archived files at ${auditBase}.*`);
    return true;
  } catch (recoveryError) {
    console.error("[audit-db] Failed to recover corrupt SQLite database", recoveryError);
    throw recoveryError;
  } finally {
    recovering = false;
  }
}
