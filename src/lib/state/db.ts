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
      createdAt TEXT NOT NULL,
      metadata  TEXT NOT NULL DEFAULT '{}'
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

    CREATE TABLE IF NOT EXISTS access_methods (
      id               TEXT PRIMARY KEY,
      deviceId         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      key              TEXT NOT NULL,
      kind             TEXT NOT NULL,
      title            TEXT NOT NULL,
      protocol         TEXT NOT NULL,
      port             INTEGER,
      secure           INTEGER NOT NULL DEFAULT 0,
      selected         INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'observed',
      credentialProtocol TEXT,
      summary          TEXT,
      metadataJson     TEXT NOT NULL DEFAULT '{}',
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_profiles (
      id                        TEXT PRIMARY KEY,
      deviceId                  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      profileId                 TEXT NOT NULL,
      adapterId                 TEXT,
      name                      TEXT NOT NULL,
      kind                      TEXT NOT NULL DEFAULT 'primary',
      confidence                REAL NOT NULL DEFAULT 0,
      status                    TEXT NOT NULL DEFAULT 'candidate',
      summary                   TEXT NOT NULL DEFAULT '',
      requiredAccessMethods     TEXT NOT NULL DEFAULT '[]',
      requiredCredentialProtocols TEXT NOT NULL DEFAULT '[]',
      evidenceJson              TEXT NOT NULL DEFAULT '{}',
      draftJson                 TEXT NOT NULL DEFAULT '{}',
      createdAt                 TEXT NOT NULL,
      updatedAt                 TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS access_surfaces (
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

    CREATE TABLE IF NOT EXISTS workloads (
      id          TEXT PRIMARY KEY,
      deviceId    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      workloadKey TEXT NOT NULL,
      displayName TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'unknown',
      criticality TEXT NOT NULL DEFAULT 'medium',
      source      TEXT NOT NULL DEFAULT 'migration',
      summary     TEXT,
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assurances (
      id               TEXT PRIMARY KEY,
      deviceId         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      workloadId       TEXT REFERENCES workloads(id) ON DELETE SET NULL,
      assuranceKey     TEXT NOT NULL,
      displayName      TEXT NOT NULL,
      criticality      TEXT NOT NULL,
      desiredState     TEXT NOT NULL DEFAULT 'running',
      checkIntervalSec INTEGER NOT NULL DEFAULT 60,
      monitorType      TEXT,
      requiredProtocols TEXT NOT NULL DEFAULT '[]',
      rationale        TEXT,
      configJson       TEXT NOT NULL DEFAULT '{}',
      serviceKey       TEXT NOT NULL DEFAULT '',
      policyJson       TEXT NOT NULL DEFAULT '{}',
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assurance_runs (
      id          TEXT PRIMARY KEY,
      assuranceId TEXT NOT NULL REFERENCES assurances(id) ON DELETE CASCADE,
      deviceId    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      workloadId  TEXT REFERENCES workloads(id) ON DELETE SET NULL,
      status      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      evaluatedAt TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS device_widgets (
      id               TEXT PRIMARY KEY,
      deviceId         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      slug             TEXT NOT NULL,
      name             TEXT NOT NULL,
      description      TEXT,
      status           TEXT NOT NULL DEFAULT 'active',
      html             TEXT NOT NULL DEFAULT '',
      css              TEXT NOT NULL DEFAULT '',
      js               TEXT NOT NULL DEFAULT '',
      capabilitiesJson TEXT NOT NULL DEFAULT '[]',
      sourcePrompt     TEXT,
      createdBy        TEXT NOT NULL DEFAULT 'steward',
      revision         INTEGER NOT NULL DEFAULT 1,
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_widget_state (
      widgetId  TEXT PRIMARY KEY REFERENCES device_widgets(id) ON DELETE CASCADE,
      deviceId  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      stateJson TEXT NOT NULL DEFAULT '{}',
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_widget_operation_runs (
      id               TEXT PRIMARY KEY,
      widgetId         TEXT NOT NULL REFERENCES device_widgets(id) ON DELETE CASCADE,
      deviceId         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      widgetRevision   INTEGER NOT NULL DEFAULT 1,
      operationKind    TEXT NOT NULL,
      operationMode    TEXT NOT NULL,
      brokerProtocol   TEXT,
      status           TEXT NOT NULL,
      phase            TEXT NOT NULL,
      proof            TEXT NOT NULL,
      approvalRequired INTEGER NOT NULL DEFAULT 0,
      policyDecision   TEXT NOT NULL,
      policyReason     TEXT NOT NULL,
      approved         INTEGER NOT NULL DEFAULT 0,
      idempotencyKey   TEXT NOT NULL,
      summary          TEXT NOT NULL,
      output           TEXT NOT NULL DEFAULT '',
      operationJson    TEXT NOT NULL DEFAULT '{}',
      detailsJson      TEXT NOT NULL DEFAULT '{}',
      createdAt        TEXT NOT NULL
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
  ensureColumn(database, "chat_messages", "metadata", "TEXT NOT NULL DEFAULT '{}'");
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_methods_device_key
      ON access_methods(deviceId, key);
    CREATE INDEX IF NOT EXISTS idx_access_methods_device_selected
      ON access_methods(deviceId, selected);
    CREATE INDEX IF NOT EXISTS idx_access_methods_device_kind
      ON access_methods(deviceId, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_profiles_device_profile
      ON device_profiles(deviceId, profileId);
    CREATE INDEX IF NOT EXISTS idx_device_profiles_device_status
      ON device_profiles(deviceId, status, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_device_adapter_bindings_device_protocol
      ON device_adapter_bindings(deviceId, protocol);
    CREATE INDEX IF NOT EXISTS idx_device_adapter_bindings_selected
      ON device_adapter_bindings(deviceId, selected);
    CREATE INDEX IF NOT EXISTS idx_access_surfaces_device_protocol
      ON access_surfaces(deviceId, protocol);
    CREATE INDEX IF NOT EXISTS idx_access_surfaces_selected
      ON access_surfaces(deviceId, selected);
    CREATE INDEX IF NOT EXISTS idx_service_contracts_deviceId ON service_contracts(deviceId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workloads_device_key
      ON workloads(deviceId, workloadKey);
    CREATE INDEX IF NOT EXISTS idx_workloads_device_updated
      ON workloads(deviceId, updatedAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assurances_device_key
      ON assurances(deviceId, assuranceKey);
    CREATE INDEX IF NOT EXISTS idx_assurances_workload
      ON assurances(workloadId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_assurance_runs_assurance
      ON assurance_runs(assuranceId, evaluatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_assurance_runs_device
      ON assurance_runs(deviceId, evaluatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_findings_device_status ON device_findings(deviceId, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_findings_dedupe_key
      ON device_findings(deviceId, dedupeKey);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_widgets_device_slug
      ON device_widgets(deviceId, slug);
    CREATE INDEX IF NOT EXISTS idx_device_widgets_device_updated
      ON device_widgets(deviceId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_widget_state_device
      ON device_widget_state(deviceId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_widget_operation_runs_widget_created
      ON device_widget_operation_runs(widgetId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_widget_operation_runs_device_created
      ON device_widget_operation_runs(deviceId, createdAt DESC);
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function inferWorkloadCategory(name: string, monitorType: string): string {
  const text = `${name} ${monitorType}`.toLowerCase();
  if (/\b(nginx|apache|caddy|traefik|haproxy|proxy|web|api)\b/.test(text)) return "application";
  if (/\b(mysql|mariadb|postgres|redis|mongo|db|database)\b/.test(text)) return "data";
  if (/\b(backup|replication|snapshot|sync|scheduler|queue|worker|cron)\b/.test(text)) return "background";
  if (/\b(vpn|dns|dhcp|gateway|router|switch|firewall)\b/.test(text)) return "network";
  if (/\b(storage|nas|nfs|smb|cifs|minio)\b/.test(text)) return "storage";
  if (/\b(metrics|monitor|telemetry|prometheus|grafana|logging)\b/.test(text)) return "telemetry";
  return "unknown";
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0);
      }
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
}

function migrateCompletedOnboardingDraftCleanup(database: Database.Database): void {
  const markerKey = "migration.completed_onboarding_draft_cleanup.v1";
  const existingMarker = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(markerKey) as { value?: string } | undefined;
  if (existingMarker?.value === "done") {
    return;
  }

  const migrate = database.transaction(() => {
    const completedRuns = database.prepare(`
      SELECT id, deviceId, profileJson, summary, updatedAt
      FROM adoption_runs
      WHERE status = 'completed'
    `).all() as Array<{ id: string; deviceId: string; profileJson: string; summary: string | null; updatedAt: string }>;

    const updateRun = database.prepare(`
      UPDATE adoption_runs
      SET profileJson = @profileJson,
          updatedAt = @updatedAt
      WHERE id = @id
    `);

    const getDevice = database.prepare(`
      SELECT id, metadata, lastChangedAt
      FROM devices
      WHERE id = ?
    `);

    const updateDevice = database.prepare(`
      UPDATE devices
      SET metadata = @metadata,
          lastChangedAt = @lastChangedAt
      WHERE id = @id
    `);

    const countWorkloads = database.prepare(`
      SELECT COUNT(*) AS count
      FROM workloads
      WHERE deviceId = ?
    `);

    const countAssurances = database.prepare(`
      SELECT COUNT(*) AS count
      FROM assurances
      WHERE deviceId = ?
    `);

    for (const run of completedRuns) {
      const profileJson = parseJsonObject(run.profileJson);
      const deletedAt = typeof profileJson.onboardingDraftDeletedAt === "string" && profileJson.onboardingDraftDeletedAt.trim().length > 0
        ? profileJson.onboardingDraftDeletedAt
        : typeof profileJson.committedAt === "string" && profileJson.committedAt.trim().length > 0
          ? profileJson.committedAt
          : run.updatedAt;

      let runChanged = false;
      if (Object.prototype.hasOwnProperty.call(profileJson, "onboardingDraft")) {
        delete profileJson.onboardingDraft;
        runChanged = true;
      }
      if (profileJson.onboardingDraftDeletedAt !== deletedAt) {
        profileJson.onboardingDraftDeletedAt = deletedAt;
        runChanged = true;
      }
      if (runChanged) {
        updateRun.run({
          id: run.id,
          profileJson: JSON.stringify(profileJson),
          updatedAt: run.updatedAt,
        });
      }

      const deviceRow = getDevice.get(run.deviceId) as { id: string; metadata: string; lastChangedAt: string } | undefined;
      if (!deviceRow) {
        continue;
      }

      const metadata = parseJsonObject(deviceRow.metadata);
      const adoption = parseJsonObject(metadata.adoption);
      const workloadCount = Number((countWorkloads.get(run.deviceId) as { count?: number } | undefined)?.count ?? 0);
      const assuranceCount = Number((countAssurances.get(run.deviceId) as { count?: number } | undefined)?.count ?? 0);
      const nextAdoption = {
        ...adoption,
        status: "adopted",
        runId: run.id,
        runStatus: "completed",
        runStage: "completed",
        profileSummary: typeof run.summary === "string" && run.summary.trim().length > 0
          ? run.summary
          : adoption.profileSummary,
        selectedProfileIds: parseStringArray(profileJson.selectedProfileIds ?? adoption.selectedProfileIds),
        requiredCredentials: parseStringArray(adoption.requiredCredentials),
        workloadCount,
        assuranceCount,
        serviceContractCount: assuranceCount,
        unresolvedRequiredQuestions: 0,
        draftSuppressedAt: deletedAt,
        completedAt: typeof profileJson.committedAt === "string" && profileJson.committedAt.trim().length > 0
          ? profileJson.committedAt
          : adoption.completedAt,
      };
      if (JSON.stringify(nextAdoption) !== JSON.stringify(adoption)) {
        metadata.adoption = nextAdoption;
        updateDevice.run({
          id: deviceRow.id,
          metadata: JSON.stringify(metadata),
          lastChangedAt: deviceRow.lastChangedAt,
        });
      }
    }

    database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      markerKey,
      "done",
    );
  });

  migrate();
}

function migrateLegacyWorkloadArchitecture(database: Database.Database): void {
  const existingMarker = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get("migration.workload_architecture.v1") as { value?: string } | undefined;
  if (existingMarker?.value === "done") {
    return;
  }

  const migrate = database.transaction(() => {
    database.prepare(`
      INSERT OR IGNORE INTO access_surfaces (
        id, deviceId, adapterId, protocol, score, selected, reason, configJson, createdAt, updatedAt
      )
      SELECT id, deviceId, adapterId, protocol, score, selected, reason, configJson, createdAt, updatedAt
      FROM device_adapter_bindings
    `).run();

    const existingWorkloads = database.prepare(
      "SELECT id, deviceId, workloadKey FROM workloads",
    ).all() as Array<{ id: string; deviceId: string; workloadKey: string }>;
    const workloadIds = new Map(existingWorkloads.map((row) => [`${row.deviceId}:${row.workloadKey}`, row.id]));

    const insertWorkload = database.prepare(`
      INSERT OR REPLACE INTO workloads (
        id, deviceId, workloadKey, displayName, category, criticality, source, summary, evidenceJson, createdAt, updatedAt
      )
      VALUES (
        @id, @deviceId, @workloadKey, @displayName, @category, @criticality, @source, @summary, @evidenceJson, @createdAt, @updatedAt
      )
    `);
    const insertAssurance = database.prepare(`
      INSERT OR REPLACE INTO assurances (
        id, deviceId, workloadId, assuranceKey, displayName, criticality, desiredState, checkIntervalSec,
        monitorType, requiredProtocols, rationale, configJson, serviceKey, policyJson, createdAt, updatedAt
      )
      VALUES (
        @id, @deviceId, @workloadId, @assuranceKey, @displayName, @criticality, @desiredState, @checkIntervalSec,
        @monitorType, @requiredProtocols, @rationale, @configJson, @serviceKey, @policyJson, @createdAt, @updatedAt
      )
    `);
    const insertRun = database.prepare(`
      INSERT OR IGNORE INTO assurance_runs (
        id, assuranceId, deviceId, workloadId, status, summary, evidenceJson, evaluatedAt
      )
      VALUES (
        @id, @assuranceId, @deviceId, @workloadId, @status, @summary, @evidenceJson, @evaluatedAt
      )
    `);

    const legacyContracts = database.prepare("SELECT * FROM service_contracts ORDER BY createdAt ASC").all() as Record<string, unknown>[];
    for (const contract of legacyContracts) {
      const deviceId = String(contract.deviceId);
      const serviceKey = String(contract.serviceKey ?? "").trim() || slugify(String(contract.displayName ?? contract.id));
      const displayName = String(contract.displayName ?? serviceKey);
      const policyJson = parseJsonObject(contract.policyJson);
      const monitorType = String(policyJson.monitorType ?? "service_presence");
      const workloadKey = slugify(serviceKey) || `workload-${String(contract.id)}`;
      const workloadLookupKey = `${deviceId}:${workloadKey}`;
      let workloadId = workloadIds.get(workloadLookupKey);
      if (!workloadId) {
        workloadId = `workload-${String(contract.id)}`;
        insertWorkload.run({
          id: workloadId,
          deviceId,
          workloadKey,
          displayName,
          category: inferWorkloadCategory(displayName, monitorType),
          criticality: String(contract.criticality ?? "medium"),
          source: String(policyJson.source ?? "migration"),
          summary: typeof policyJson.rationale === "string"
            ? policyJson.rationale
            : typeof policyJson.reason === "string"
              ? policyJson.reason
              : null,
          evidenceJson: JSON.stringify({
            migratedFrom: "service_contracts",
            legacyServiceKey: serviceKey,
            monitorType,
          }),
          createdAt: String(contract.createdAt),
          updatedAt: String(contract.updatedAt),
        });
        workloadIds.set(workloadLookupKey, workloadId);
      }

      insertAssurance.run({
        id: String(contract.id),
        deviceId,
        workloadId,
        assuranceKey: serviceKey,
        displayName,
        criticality: String(contract.criticality ?? "medium"),
        desiredState: String(contract.desiredState ?? "running"),
        checkIntervalSec: Number(contract.checkIntervalSec ?? 60),
        monitorType,
        requiredProtocols: JSON.stringify(parseStringArray(policyJson.requiredProtocols)),
        rationale: typeof policyJson.rationale === "string"
          ? policyJson.rationale
          : typeof policyJson.reason === "string"
            ? policyJson.reason
            : null,
        configJson: JSON.stringify(policyJson),
        serviceKey,
        policyJson: JSON.stringify(policyJson),
        createdAt: String(contract.createdAt),
        updatedAt: String(contract.updatedAt),
      });

      const lastStatus = String(policyJson.lastStatus ?? "").trim().toLowerCase();
      const evaluatedAt = typeof policyJson.lastEvaluatedAt === "string" && policyJson.lastEvaluatedAt.trim().length > 0
        ? policyJson.lastEvaluatedAt
        : String(contract.updatedAt);
      if (lastStatus === "pass" || lastStatus === "fail" || lastStatus === "pending" || lastStatus === "pending_credentials") {
        insertRun.run({
          id: `migrated-${String(contract.id)}`,
          assuranceId: String(contract.id),
          deviceId,
          workloadId,
          status: lastStatus === "pending_credentials" ? "pending" : lastStatus,
          summary: `Migrated latest legacy contract status for ${displayName}.`,
          evidenceJson: JSON.stringify({
            migratedFrom: "service_contracts",
            legacyStatus: lastStatus,
          }),
          evaluatedAt,
        });
      }
    }

    database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      "migration.workload_architecture.v1",
      "done",
    );
  });

  migrate();
}

export function getDb(): Database.Database {
  if (stateDb) return stateDb;

  mkdirSync(DATA_DIR, { recursive: true });
  stateDb = new Database(STATE_DB_PATH);
  try {
    stateDb.pragma("journal_mode = WAL");
    stateDb.pragma("foreign_keys = ON");
    createSchema(stateDb);
    migrateLegacyWorkloadArchitecture(stateDb);
    migrateCompletedOnboardingDraftCleanup(stateDb);
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

    CREATE TABLE IF NOT EXISTS credential_access_events (
      id             TEXT PRIMARY KEY,
      credentialId   TEXT,
      deviceId       TEXT NOT NULL,
      protocol       TEXT NOT NULL,
      playbookRunId  TEXT,
      operationId    TEXT,
      adapterId      TEXT,
      actor          TEXT NOT NULL,
      purpose        TEXT NOT NULL,
      result         TEXT NOT NULL,
      details        TEXT NOT NULL DEFAULT '{}',
      accessedAt     TEXT NOT NULL,
      createdAt      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_kind ON audit_events(kind);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_status ON durable_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_durable_jobs_runAfter ON durable_jobs(runAfter);
    CREATE INDEX IF NOT EXISTS idx_credential_access_events_accessedAt ON credential_access_events(accessedAt);
    CREATE INDEX IF NOT EXISTS idx_credential_access_events_deviceId ON credential_access_events(deviceId);
    CREATE INDEX IF NOT EXISTS idx_credential_access_events_result ON credential_access_events(result);
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
