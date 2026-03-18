import Database from "better-sqlite3";
import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

const STANDALONE_PATH_SEGMENT = `${path.sep}.next${path.sep}standalone`;
const STAGED_RUNTIME_BUILD_SEGMENT = `${path.sep}build${path.sep}`;

function resolveRepoRootFromStandaloneCwd(cwd: string): string | null {
  const standaloneIdx = cwd.lastIndexOf(STANDALONE_PATH_SEGMENT);

  if (standaloneIdx === -1) {
    return null;
  }

  const repoRoot = cwd.slice(0, standaloneIdx);
  return repoRoot || null;
}

function resolveRepoRootFromStagedRuntimeCwd(cwd: string): string | null {
  const buildIdx = cwd.lastIndexOf(STAGED_RUNTIME_BUILD_SEGMENT);
  if (buildIdx === -1) {
    return null;
  }

  const runtimeTail = cwd.slice(buildIdx + STAGED_RUNTIME_BUILD_SEGMENT.length);
  const [runtimeSegment] = runtimeTail.split(path.sep);
  if (!runtimeSegment?.startsWith("standalone-runtime-")) {
    return null;
  }

  const repoRoot = cwd.slice(0, buildIdx);
  return repoRoot || null;
}

export function resolveDataDirForCwd(cwdInput: string): string {
  const cwd = path.resolve(cwdInput);
  const repoRoot = resolveRepoRootFromStandaloneCwd(cwd)
    ?? resolveRepoRootFromStagedRuntimeCwd(cwd);

  if (repoRoot) {
    return path.join(repoRoot, ".steward");
  }

  return path.join(cwd, ".steward");
}

const DATA_DIR = resolveDataDirForCwd(process.cwd());
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
      siteId        TEXT NOT NULL DEFAULT 'site.local.default',
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
      updatedAt        TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS graph_node_versions (
      id           TEXT PRIMARY KEY,
      nodeId       TEXT NOT NULL,
      label        TEXT NOT NULL,
      properties   TEXT NOT NULL DEFAULT '{}',
      snapshotHash TEXT NOT NULL,
      versionedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_edge_versions (
      id           TEXT PRIMARY KEY,
      edgeId       TEXT NOT NULL,
      "from"       TEXT NOT NULL,
      "to"         TEXT NOT NULL,
      type         TEXT NOT NULL,
      properties   TEXT NOT NULL DEFAULT '{}',
      snapshotHash TEXT NOT NULL,
      versionedAt  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sites (
      id        TEXT PRIMARY KEY,
      slug      TEXT NOT NULL UNIQUE,
      name      TEXT NOT NULL,
      timezone  TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metric_series (
      id            TEXT PRIMARY KEY,
      scopeType     TEXT NOT NULL,
      scopeId       TEXT NOT NULL,
      metricKey     TEXT NOT NULL,
      unit          TEXT,
      source        TEXT NOT NULL,
      retentionDays INTEGER NOT NULL DEFAULT 30,
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL,
      UNIQUE(scopeType, scopeId, metricKey)
    );

    CREATE TABLE IF NOT EXISTS metric_samples (
      id            TEXT PRIMARY KEY,
      seriesId      TEXT NOT NULL,
      scopeType     TEXT NOT NULL,
      scopeId       TEXT NOT NULL,
      metricKey     TEXT NOT NULL,
      value         REAL NOT NULL,
      unit          TEXT,
      source        TEXT NOT NULL,
      observedAt    TEXT NOT NULL,
      dimensionsJson TEXT NOT NULL DEFAULT '{}',
      anomalyScore  REAL,
      baselineLower REAL,
      baselineUpper REAL
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      provider         TEXT PRIMARY KEY,
      enabled          INTEGER NOT NULL DEFAULT 1,
      model            TEXT NOT NULL,
      oauthTokenSecret TEXT,
      oauthAuthUrl     TEXT,
      oauthTokenUrl    TEXT,
      oauthScopes      TEXT,
      baseUrl          TEXT,
      extraHeaders     TEXT,
      updatedAt        TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS scanner_runs (
      id          TEXT PRIMARY KEY,
      startedAt   TEXT NOT NULL,
      completedAt TEXT,
      outcome     TEXT NOT NULL,
      summary     TEXT NOT NULL,
      details     TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS runtime_leases (
      name         TEXT PRIMARY KEY,
      holder       TEXT NOT NULL,
      expiresAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}'
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
      failureCount       INTEGER NOT NULL DEFAULT 0,
      updatedAt          TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS local_tools (
      id               TEXT PRIMARY KEY,
      manifestJson     TEXT NOT NULL DEFAULT '{}',
      enabled          INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL DEFAULT 'not_installed',
      healthStatus     TEXT NOT NULL DEFAULT 'unknown',
      installDir       TEXT,
      binPathsJson     TEXT NOT NULL DEFAULT '{}',
      installedVersion TEXT,
      lastInstalledAt  TEXT,
      lastCheckedAt    TEXT,
      lastRunAt        TEXT,
      approvedAt       TEXT,
      error            TEXT,
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS local_tool_approvals (
      id           TEXT PRIMARY KEY,
      toolId       TEXT NOT NULL REFERENCES local_tools(id) ON DELETE CASCADE,
      action       TEXT NOT NULL,
      status       TEXT NOT NULL,
      requestedBy  TEXT NOT NULL,
      requestedAt  TEXT NOT NULL,
      expiresAt    TEXT,
      reason       TEXT NOT NULL,
      requestJson  TEXT NOT NULL DEFAULT '{}',
      approvedBy   TEXT,
      approvedAt   TEXT,
      deniedBy     TEXT,
      deniedAt     TEXT,
      denialReason TEXT,
      decisionJson TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS protocol_sessions (
      id                 TEXT PRIMARY KEY,
      deviceId           TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      protocol           TEXT NOT NULL,
      adapterId          TEXT,
      desiredState       TEXT NOT NULL DEFAULT 'idle',
      status             TEXT NOT NULL DEFAULT 'idle',
      arbitrationMode    TEXT NOT NULL DEFAULT 'shared',
      singleConnectionHint INTEGER NOT NULL DEFAULT 0,
      keepaliveAllowed   INTEGER NOT NULL DEFAULT 0,
      summary            TEXT,
      configJson         TEXT NOT NULL DEFAULT '{}',
      activeLeaseId      TEXT,
      lastConnectedAt    TEXT,
      lastDisconnectedAt TEXT,
      lastMessageAt      TEXT,
      lastError          TEXT,
      createdAt          TEXT NOT NULL,
      updatedAt          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS protocol_session_leases (
      id           TEXT PRIMARY KEY,
      sessionId    TEXT NOT NULL REFERENCES protocol_sessions(id) ON DELETE CASCADE,
      holder       TEXT NOT NULL,
      purpose      TEXT NOT NULL,
      mode         TEXT NOT NULL,
      status       TEXT NOT NULL,
      exclusive    INTEGER NOT NULL DEFAULT 0,
      requestedAt  TEXT NOT NULL,
      grantedAt    TEXT,
      releasedAt   TEXT,
      expiresAt    TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS protocol_session_messages (
      id           TEXT PRIMARY KEY,
      sessionId    TEXT NOT NULL REFERENCES protocol_sessions(id) ON DELETE CASCADE,
      deviceId     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      direction    TEXT NOT NULL,
      channel      TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '',
      metadataJson TEXT NOT NULL DEFAULT '{}',
      observedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id        TEXT PRIMARY KEY,
      title     TEXT NOT NULL,
      deviceId  TEXT REFERENCES devices(id) ON DELETE SET NULL,
      missionId TEXT,
      subagentId TEXT,
      gatewayThreadId TEXT,
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

    CREATE TABLE IF NOT EXISTS packs (
      id           TEXT PRIMARY KEY,
      slug         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      version      TEXT NOT NULL DEFAULT '0.0.0',
      description  TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'builtin',
      enabled      INTEGER NOT NULL DEFAULT 1,
      builtin      INTEGER NOT NULL DEFAULT 0,
      trustMode    TEXT NOT NULL DEFAULT 'unsigned',
      signerId     TEXT,
      signature    TEXT,
      signatureAlgorithm TEXT,
      verificationStatus TEXT NOT NULL DEFAULT 'unsigned',
      verifiedAt   TEXT,
      manifestJson TEXT NOT NULL DEFAULT '{}',
      installedAt  TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pack_signers (
      id           TEXT PRIMARY KEY,
      slug         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      publicKeyPem TEXT NOT NULL,
      algorithm    TEXT NOT NULL DEFAULT 'ed25519',
      trustScope   TEXT NOT NULL DEFAULT 'trusted',
      enabled      INTEGER NOT NULL DEFAULT 1,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pack_installs (
      id          TEXT PRIMARY KEY,
      packId      TEXT NOT NULL UNIQUE REFERENCES packs(id) ON DELETE CASCADE,
      enabled     INTEGER NOT NULL DEFAULT 1,
      installedAt TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pack_versions (
      id           TEXT PRIMARY KEY,
      packId       TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      version      TEXT NOT NULL,
      action       TEXT NOT NULL,
      manifestJson TEXT NOT NULL DEFAULT '{}',
      createdAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pack_resources (
      id          TEXT PRIMARY KEY,
      packId      TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      resourceKey TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subagents (
      id               TEXT PRIMARY KEY,
      slug             TEXT NOT NULL UNIQUE,
      name             TEXT NOT NULL,
      description      TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'active',
      scopeJson        TEXT NOT NULL DEFAULT '{}',
      autonomyJson     TEXT NOT NULL DEFAULT '{}',
      packId           TEXT REFERENCES packs(id) ON DELETE SET NULL,
      channelBindingId TEXT,
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subagent_memories (
      id           TEXT PRIMARY KEY,
      subagentId   TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
      missionId    TEXT REFERENCES missions(id) ON DELETE SET NULL,
      deviceId     TEXT REFERENCES devices(id) ON DELETE SET NULL,
      kind         TEXT NOT NULL,
      summary      TEXT NOT NULL,
      detail       TEXT NOT NULL DEFAULT '',
      importance   TEXT NOT NULL DEFAULT 'medium',
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      lastUsedAt   TEXT,
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS standing_orders (
      id           TEXT PRIMARY KEY,
      subagentId   TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      objective    TEXT NOT NULL DEFAULT '',
      instructionsJson TEXT NOT NULL DEFAULT '[]',
      enabled      INTEGER NOT NULL DEFAULT 1,
      scopeJson    TEXT NOT NULL DEFAULT '{}',
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS missions (
      id            TEXT PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      summary       TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      priority      TEXT NOT NULL DEFAULT 'medium',
      objective     TEXT NOT NULL DEFAULT '',
      subagentId    TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      packId        TEXT REFERENCES packs(id) ON DELETE SET NULL,
      cadenceMinutes INTEGER NOT NULL DEFAULT 60,
      autoRun       INTEGER NOT NULL DEFAULT 1,
      autoApprove   INTEGER NOT NULL DEFAULT 0,
      shadowMode    INTEGER NOT NULL DEFAULT 0,
      targetJson    TEXT NOT NULL DEFAULT '{}',
      stateJson     TEXT NOT NULL DEFAULT '{}',
      lastRunAt     TEXT,
      nextRunAt     TEXT,
      lastStatus    TEXT,
      lastSummary   TEXT,
      createdBy     TEXT NOT NULL DEFAULT 'steward',
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_links (
      id           TEXT PRIMARY KEY,
      missionId    TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      resourceType TEXT NOT NULL,
      resourceId   TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}',
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_runs (
      id          TEXT PRIMARY KEY,
      missionId   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      subagentId  TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      status      TEXT NOT NULL,
      summary     TEXT NOT NULL,
      outcomeJson TEXT NOT NULL DEFAULT '{}',
      startedAt   TEXT NOT NULL,
      completedAt TEXT,
      createdAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_delegations (
      id            TEXT PRIMARY KEY,
      missionId     TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      fromSubagentId TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      toSubagentId  TEXT NOT NULL REFERENCES subagents(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      reason        TEXT NOT NULL DEFAULT '',
      payloadJson   TEXT NOT NULL DEFAULT '{}',
      createdAt     TEXT NOT NULL,
      updatedAt     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_plans (
      id                TEXT PRIMARY KEY,
      missionId         TEXT NOT NULL UNIQUE REFERENCES missions(id) ON DELETE CASCADE,
      summary           TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'active',
      checkpointsJson   TEXT NOT NULL DEFAULT '[]',
      delegationIdsJson TEXT NOT NULL DEFAULT '[]',
      createdAt         TEXT NOT NULL,
      updatedAt         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investigations (
      id          TEXT PRIMARY KEY,
      missionId   TEXT REFERENCES missions(id) ON DELETE SET NULL,
      subagentId  TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      parentInvestigationId TEXT REFERENCES investigations(id) ON DELETE SET NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      severity    TEXT NOT NULL DEFAULT 'warning',
      stage       TEXT NOT NULL DEFAULT 'detect',
      objective   TEXT NOT NULL DEFAULT '',
      hypothesis  TEXT,
      summary     TEXT NOT NULL DEFAULT '',
      sourceType  TEXT,
      sourceId    TEXT,
      deviceId    TEXT REFERENCES devices(id) ON DELETE SET NULL,
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      recommendedActionsJson TEXT NOT NULL DEFAULT '[]',
      unresolvedQuestionsJson TEXT NOT NULL DEFAULT '[]',
      nextRunAt   TEXT,
      lastRunAt   TEXT,
      resolution  TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investigation_steps (
      id              TEXT PRIMARY KEY,
      investigationId TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'completed',
      title           TEXT NOT NULL,
      detail          TEXT NOT NULL DEFAULT '',
      evidenceJson    TEXT NOT NULL DEFAULT '{}',
      createdAt       TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS finding_occurrences (
      id           TEXT PRIMARY KEY,
      findingId    TEXT REFERENCES device_findings(id) ON DELETE SET NULL,
      deviceId     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      dedupeKey    TEXT NOT NULL,
      findingType  TEXT NOT NULL,
      severity     TEXT NOT NULL,
      status       TEXT NOT NULL,
      summary      TEXT NOT NULL,
      evidenceJson TEXT NOT NULL DEFAULT '{}',
      source       TEXT NOT NULL,
      observedAt   TEXT NOT NULL,
      metadataJson TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS notification_channels (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      target          TEXT NOT NULL,
      eventKinds      TEXT NOT NULL DEFAULT '[]',
      minimumSeverity TEXT,
      vaultSecretRef  TEXT,
      configJson      TEXT NOT NULL DEFAULT '{}',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id          TEXT PRIMARY KEY,
      channelId   TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
      eventKind   TEXT NOT NULL,
      eventRef    TEXT NOT NULL,
      summary     TEXT NOT NULL,
      payloadJson TEXT NOT NULL DEFAULT '{}',
      status      TEXT NOT NULL DEFAULT 'pending',
      attempts    INTEGER NOT NULL DEFAULT 0,
      lastError   TEXT,
      deliveredAt TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_bindings (
      id                 TEXT PRIMARY KEY,
      kind               TEXT NOT NULL,
      name               TEXT NOT NULL,
      enabled            INTEGER NOT NULL DEFAULT 1,
      target             TEXT NOT NULL DEFAULT '',
      vaultSecretRef     TEXT,
      webhookSecret      TEXT,
      defaultThreadTitle TEXT,
      configJson         TEXT NOT NULL DEFAULT '{}',
      lastInboundAt      TEXT,
      lastOutboundAt     TEXT,
      createdAt          TEXT NOT NULL,
      updatedAt          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_threads (
      id                TEXT PRIMARY KEY,
      bindingId         TEXT NOT NULL REFERENCES gateway_bindings(id) ON DELETE CASCADE,
      externalThreadKey TEXT NOT NULL,
      title             TEXT NOT NULL,
      missionId         TEXT REFERENCES missions(id) ON DELETE SET NULL,
      subagentId        TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      chatSessionId     TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      lastInboundAt     TEXT,
      lastOutboundAt    TEXT,
      createdAt         TEXT NOT NULL,
      updatedAt         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_inbound_events (
      id               TEXT PRIMARY KEY,
      bindingId        TEXT NOT NULL REFERENCES gateway_bindings(id) ON DELETE CASCADE,
      externalUpdateId TEXT NOT NULL,
      threadId         TEXT REFERENCES gateway_threads(id) ON DELETE SET NULL,
      receivedAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS briefings (
      id          TEXT PRIMARY KEY,
      scope       TEXT NOT NULL DEFAULT 'global',
      subagentId  TEXT REFERENCES subagents(id) ON DELETE SET NULL,
      missionId   TEXT REFERENCES missions(id) ON DELETE SET NULL,
      bindingId   TEXT REFERENCES gateway_bindings(id) ON DELETE SET NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      format      TEXT NOT NULL DEFAULT 'markdown',
      delivered   INTEGER NOT NULL DEFAULT 0,
      deliveredAt TEXT,
      metadataJson TEXT NOT NULL DEFAULT '{}',
      createdAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_delivery_events (
      id          TEXT PRIMARY KEY,
      bindingId   TEXT NOT NULL REFERENCES gateway_bindings(id) ON DELETE CASCADE,
      threadId    TEXT REFERENCES gateway_threads(id) ON DELETE SET NULL,
      missionId   TEXT REFERENCES missions(id) ON DELETE SET NULL,
      briefingId  TEXT REFERENCES briefings(id) ON DELETE SET NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      textPreview TEXT NOT NULL DEFAULT '',
      requestedAt TEXT NOT NULL,
      deliveredAt TEXT,
      error       TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
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
      controlsJson     TEXT NOT NULL DEFAULT '[]',
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

    CREATE TABLE IF NOT EXISTS device_automations (
      id              TEXT PRIMARY KEY,
      deviceId        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      targetKind      TEXT NOT NULL DEFAULT 'widget-control',
      widgetId        TEXT NOT NULL REFERENCES device_widgets(id) ON DELETE CASCADE,
      controlId       TEXT NOT NULL,
      targetJson      TEXT NOT NULL DEFAULT '{}',
      name            TEXT NOT NULL,
      description     TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      scheduleKind    TEXT NOT NULL DEFAULT 'manual',
      intervalMinutes INTEGER,
      hourLocal       INTEGER,
      minuteLocal     INTEGER,
      inputJson       TEXT NOT NULL DEFAULT '{}',
      lastRunAt       TEXT,
      nextRunAt       TEXT,
      lastRunStatus   TEXT,
      lastRunSummary  TEXT,
      createdBy       TEXT NOT NULL DEFAULT 'steward',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS device_automation_runs (
      id           TEXT PRIMARY KEY,
      automationId TEXT NOT NULL REFERENCES device_automations(id) ON DELETE CASCADE,
      deviceId     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      widgetId     TEXT NOT NULL REFERENCES device_widgets(id) ON DELETE CASCADE,
      controlId    TEXT NOT NULL,
      status       TEXT NOT NULL,
      summary      TEXT NOT NULL,
      resultJson   TEXT NOT NULL DEFAULT '{}',
      createdAt    TEXT NOT NULL,
      completedAt  TEXT
    );

    CREATE TABLE IF NOT EXISTS dashboard_widget_pages (
      id        TEXT PRIMARY KEY,
      slug      TEXT NOT NULL,
      name      TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboard_widget_page_items (
      id         TEXT PRIMARY KEY,
      pageId     TEXT NOT NULL REFERENCES dashboard_widget_pages(id) ON DELETE CASCADE,
      widgetId   TEXT NOT NULL REFERENCES device_widgets(id) ON DELETE CASCADE,
      title      TEXT,
      columnStart INTEGER NOT NULL DEFAULT 1,
      columnSpan INTEGER NOT NULL DEFAULT 6,
      rowStart   INTEGER NOT NULL DEFAULT 1,
      rowSpan    INTEGER NOT NULL DEFAULT 4,
      sortOrder  INTEGER NOT NULL DEFAULT 0,
      createdAt  TEXT NOT NULL,
      updatedAt  TEXT NOT NULL
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
  ensureColumn(database, "chat_sessions", "missionId", "TEXT");
  ensureColumn(database, "chat_sessions", "subagentId", "TEXT");
  ensureColumn(database, "chat_sessions", "gatewayThreadId", "TEXT");
  ensureColumn(database, "chat_messages", "metadata", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "devices", "siteId", "TEXT NOT NULL DEFAULT 'site.local.default'");
  ensureColumn(database, "devices", "secondaryIps", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "recommendations", "updatedAt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "adapters", "source", "TEXT NOT NULL DEFAULT 'file'");
  ensureColumn(database, "adapters", "docsUrl", "TEXT");
  ensureColumn(database, "adapters", "manifestJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "adapters", "configSchema", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "adapters", "config", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "adapters", "toolSkills", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "adapters", "toolConfig", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "dashboard_widget_page_items", "columnStart", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "dashboard_widget_page_items", "rowStart", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(database, "device_widgets", "controlsJson", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "device_automations", "targetJson", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, "packs", "trustMode", "TEXT NOT NULL DEFAULT 'unsigned'");
  ensureColumn(database, "packs", "signerId", "TEXT");
  ensureColumn(database, "packs", "signature", "TEXT");
  ensureColumn(database, "packs", "signatureAlgorithm", "TEXT");
  ensureColumn(database, "packs", "verificationStatus", "TEXT NOT NULL DEFAULT 'unsigned'");
  ensureColumn(database, "packs", "verifiedAt", "TEXT");
  ensureColumn(database, "playbook_runs", "updatedAt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "missions", "shadowMode", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "investigations", "parentInvestigationId", "TEXT REFERENCES investigations(id) ON DELETE SET NULL");
  ensureColumn(database, "investigations", "stage", "TEXT NOT NULL DEFAULT 'detect'");
  ensureColumn(database, "investigations", "recommendedActionsJson", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "investigations", "unresolvedQuestionsJson", "TEXT NOT NULL DEFAULT '[]'");

  // Indexes for frequently queried columns
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_devices_ip ON devices(ip);
    CREATE INDEX IF NOT EXISTS idx_devices_siteId ON devices(siteId);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_actions_kind ON actions(kind);
    CREATE INDEX IF NOT EXISTS idx_actions_at ON actions(at);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges("from");
    CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges("to");
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_updatedAt ON graph_nodes(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_graph_node_versions_node_versionedAt ON graph_node_versions(nodeId, versionedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_graph_edge_versions_edge_versionedAt ON graph_edge_versions(edgeId, versionedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug);
    CREATE INDEX IF NOT EXISTS idx_metric_series_scope_metric ON metric_series(scopeType, scopeId, metricKey);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_series_observedAt ON metric_samples(seriesId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_scope_metric_observedAt ON metric_samples(scopeType, scopeId, metricKey, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_startedAt ON agent_runs(startedAt);
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expiresAt ON oauth_states(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_policy_rules_priority ON policy_rules(priority);
    CREATE INDEX IF NOT EXISTS idx_policy_rules_enabled ON policy_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_status ON playbook_runs(status);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_deviceId ON playbook_runs(deviceId);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_createdAt ON playbook_runs(createdAt);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_updatedAt ON playbook_runs(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_daily_digests_generatedAt ON daily_digests(generatedAt);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updatedAt ON chat_sessions(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_deviceId ON chat_sessions(deviceId);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_missionId ON chat_sessions(missionId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_gatewayThreadId ON chat_sessions(gatewayThreadId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_sessionId ON chat_messages(sessionId);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_createdAt ON chat_messages(createdAt);
    CREATE INDEX IF NOT EXISTS idx_packs_slug_enabled ON packs(slug, enabled);
    CREATE INDEX IF NOT EXISTS idx_packs_signer_verification ON packs(signerId, verificationStatus, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_pack_signers_slug_enabled ON pack_signers(slug, enabled);
    CREATE INDEX IF NOT EXISTS idx_pack_versions_packId_createdAt ON pack_versions(packId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_pack_resources_packId_type ON pack_resources(packId, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_resources_packId_resourceKey ON pack_resources(packId, resourceKey);
    CREATE INDEX IF NOT EXISTS idx_pack_installs_packId ON pack_installs(packId);
    CREATE INDEX IF NOT EXISTS idx_missions_subagent_status ON missions(subagentId, status);
    CREATE INDEX IF NOT EXISTS idx_missions_nextRunAt ON missions(nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_mission_links_mission_resource ON mission_links(missionId, resourceType, resourceId);
    CREATE INDEX IF NOT EXISTS idx_investigations_mission_status ON investigations(missionId, status);
    CREATE INDEX IF NOT EXISTS idx_investigations_stage ON investigations(stage, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_investigation_steps_investigation_createdAt ON investigation_steps(investigationId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_adapters_source ON adapters(source);
    CREATE INDEX IF NOT EXISTS idx_local_tools_status ON local_tools(status);
    CREATE INDEX IF NOT EXISTS idx_local_tools_updatedAt ON local_tools(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_local_tool_approvals_tool_status
      ON local_tool_approvals(toolId, status, requestedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_local_tool_approvals_status_expires
      ON local_tool_approvals(status, expiresAt);
    CREATE INDEX IF NOT EXISTS idx_protocol_sessions_device_protocol
      ON protocol_sessions(deviceId, protocol);
    CREATE INDEX IF NOT EXISTS idx_protocol_sessions_status
      ON protocol_sessions(status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_protocol_session_leases_session_status
      ON protocol_session_leases(sessionId, status, expiresAt);
    CREATE INDEX IF NOT EXISTS idx_protocol_session_leases_holder
      ON protocol_session_leases(holder, status, expiresAt);
    CREATE INDEX IF NOT EXISTS idx_protocol_session_messages_session_observed
      ON protocol_session_messages(sessionId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_protocol_session_messages_device_observed
      ON protocol_session_messages(deviceId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_ip ON discovery_observations(ip);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_observedAt ON discovery_observations(observedAt);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_expiresAt ON discovery_observations(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_discovery_observations_deviceId ON discovery_observations(deviceId);
    CREATE INDEX IF NOT EXISTS idx_adoption_runs_deviceId ON adoption_runs(deviceId);
    CREATE INDEX IF NOT EXISTS idx_adoption_runs_status ON adoption_runs(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_inbound_events_binding_update
      ON gateway_inbound_events(bindingId, externalUpdateId);
    CREATE INDEX IF NOT EXISTS idx_gateway_threads_binding_thread ON gateway_threads(bindingId, externalThreadKey);
    CREATE INDEX IF NOT EXISTS idx_briefings_binding_createdAt ON briefings(bindingId, createdAt DESC);
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subagents_slug
      ON subagents(slug);
    CREATE INDEX IF NOT EXISTS idx_subagents_status
      ON subagents(status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_subagent_memories_subagent_used
      ON subagent_memories(subagentId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_standing_orders_subagent_enabled
      ON standing_orders(subagentId, enabled, updatedAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_slug
      ON missions(slug);
    CREATE INDEX IF NOT EXISTS idx_missions_status_next
      ON missions(status, nextRunAt, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_missions_subagent
      ON missions(subagentId, status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_delegations_mission_status
      ON mission_delegations(missionId, status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_delegations_target_status
      ON mission_delegations(toSubagentId, status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_mission_plans_mission
      ON mission_plans(missionId, updatedAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_links_unique
      ON mission_links(missionId, resourceType, resourceId);
    CREATE INDEX IF NOT EXISTS idx_mission_runs_mission_created
      ON mission_runs(missionId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_investigations_status_updated
      ON investigations(status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_investigations_mission_status
      ON investigations(missionId, status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_investigation_steps_investigation_created
      ON investigation_steps(investigationId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_findings_device_status ON device_findings(deviceId, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_device_findings_dedupe_key
      ON device_findings(deviceId, dedupeKey);
    CREATE INDEX IF NOT EXISTS idx_finding_occurrences_device_observed
      ON finding_occurrences(deviceId, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_finding_occurrences_dedupe_observed
      ON finding_occurrences(dedupeKey, observedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled
      ON notification_channels(enabled, kind, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_created
      ON notification_deliveries(channelId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_created
      ON notification_deliveries(status, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_gateway_bindings_enabled
      ON gateway_bindings(enabled, kind, updatedAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gateway_threads_binding_external
      ON gateway_threads(bindingId, externalThreadKey);
    CREATE INDEX IF NOT EXISTS idx_gateway_threads_updated
      ON gateway_threads(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_briefings_created
      ON briefings(createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_events_binding_requested
      ON channel_delivery_events(bindingId, requestedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_events_status_requested
      ON channel_delivery_events(status, requestedAt DESC);
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
    CREATE INDEX IF NOT EXISTS idx_device_automations_device_updated
      ON device_automations(deviceId, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_automations_device_next
      ON device_automations(deviceId, enabled, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_device_automations_widget_control
      ON device_automations(widgetId, controlId);
    CREATE INDEX IF NOT EXISTS idx_device_automation_runs_automation_created
      ON device_automation_runs(automationId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_device_automation_runs_device_created
      ON device_automation_runs(deviceId, createdAt DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_widget_pages_slug
      ON dashboard_widget_pages(slug);
    CREATE INDEX IF NOT EXISTS idx_dashboard_widget_pages_sort
      ON dashboard_widget_pages(sortOrder ASC, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_dashboard_widget_page_items_page_sort
      ON dashboard_widget_page_items(pageId, sortOrder ASC, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_dashboard_widget_page_items_page_grid
      ON dashboard_widget_page_items(pageId, rowStart ASC, columnStart ASC, sortOrder ASC);
    CREATE INDEX IF NOT EXISTS idx_dashboard_widget_page_items_widget
      ON dashboard_widget_page_items(widgetId);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_userId ON auth_sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiresAt ON auth_sessions(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_auth_users_role ON auth_users(role);
    CREATE INDEX IF NOT EXISTS idx_auth_oidc_states_expiresAt ON auth_oidc_states(expiresAt);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_history_domain_version ON settings_history(domain, version);
    CREATE INDEX IF NOT EXISTS idx_settings_history_domain_effectiveFrom ON settings_history(domain, effectiveFrom DESC, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_leases_expiresAt ON runtime_leases(expiresAt);
    CREATE INDEX IF NOT EXISTS idx_scanner_runs_startedAt ON scanner_runs(startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_startedAt ON agent_runs(startedAt DESC);
  `);

  const scannerRunsBackfill = database.prepare(
    "SELECT value FROM metadata WHERE key = 'migration.scanner_runs_backfill'",
  ).get() as { value: string } | undefined;
  if (!scannerRunsBackfill) {
    database.exec(`
      INSERT OR IGNORE INTO scanner_runs (id, startedAt, completedAt, outcome, summary, details)
      SELECT id, startedAt, completedAt, outcome, summary, details
      FROM agent_runs;

      DELETE FROM agent_runs;
    `);
    database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      "migration.scanner_runs_backfill",
      new Date().toISOString(),
    );
  }

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

function migrateLegacyWidgetJsonParsers(database: Database.Database): void {
  const markerKey = "migration.widget_json_output_parser.v1";
  const existingMarker = database
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(markerKey) as { value?: string } | undefined;
  if (existingMarker?.value === "done") {
    return;
  }

  const migrate = database.transaction(() => {
    const rows = database.prepare(`
      SELECT id, js, revision
      FROM device_widgets
    `).all() as Array<{ id: string; js: string; revision?: number }>;

    const updateWidget = database.prepare(`
      UPDATE device_widgets
      SET js = @js,
          revision = @revision,
          updatedAt = @updatedAt
      WHERE id = @id
    `);

    const replacement = [
      "function parseJson(text) {",
      "  return SW.extractJsonOutput(text);",
      "}",
    ].join("\n");

    for (const row of rows) {
      if (
        typeof row.js !== "string"
        || !row.js.includes("function parseJson(text) {")
        || !row.js.includes("const cleaned = text.replace(/#< CLIXML")
        || !row.js.includes("const m = text.match(/[\\[{][\\s\\S]*[\\]}]/);")
        || !row.js.includes("async function refreshAll()")
      ) {
        continue;
      }

      const start = row.js.indexOf("function parseJson(text) {");
      const end = row.js.indexOf("\n\nasync function refreshAll()", start);
      if (start === -1 || end === -1 || end <= start) {
        continue;
      }

      const nextJs = `${row.js.slice(0, start)}${replacement}${row.js.slice(end)}`;
      if (nextJs === row.js) {
        continue;
      }

      updateWidget.run({
        id: row.id,
        js: nextJs,
        revision: Math.max(1, Number(row.revision ?? 0) + 1),
        updatedAt: new Date().toISOString(),
      });
    }

    database.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      markerKey,
      "done",
    );
  });

  migrate();
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

function migrateProviderConfigSchema(database: Database.Database): void {
  const requiresRebuild =
    hasColumn(database, "provider_configs", "apiKeyEnvVar")
    || hasColumn(database, "provider_configs", "oauthClientIdEnvVar")
    || hasColumn(database, "provider_configs", "oauthClientSecretEnvVar")
    || !hasColumn(database, "provider_configs", "updatedAt");

  if (!requiresRebuild) {
    return;
  }

  const preserveUpdatedAt = hasColumn(database, "provider_configs", "updatedAt");

  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE provider_configs_next (
        provider         TEXT PRIMARY KEY,
        enabled          INTEGER NOT NULL DEFAULT 1,
        model            TEXT NOT NULL,
        oauthTokenSecret TEXT,
        oauthAuthUrl     TEXT,
        oauthTokenUrl    TEXT,
        oauthScopes      TEXT,
        baseUrl          TEXT,
        extraHeaders     TEXT,
        updatedAt        TEXT NOT NULL
      );
    `);

    const selectUpdatedAt = preserveUpdatedAt
      ? "COALESCE(updatedAt, CURRENT_TIMESTAMP)"
      : "CURRENT_TIMESTAMP";

    database.exec(`
      INSERT INTO provider_configs_next (
        provider, enabled, model, oauthTokenSecret, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders, updatedAt
      )
      SELECT
        provider,
        enabled,
        model,
        oauthTokenSecret,
        oauthAuthUrl,
        oauthTokenUrl,
        oauthScopes,
        baseUrl,
        extraHeaders,
        ${selectUpdatedAt}
      FROM provider_configs;

      DROP TABLE provider_configs;
      ALTER TABLE provider_configs_next RENAME TO provider_configs;
    `);
  });

  migrate();
}

function migrateReleaseStateSchema(database: Database.Database): void {
  ensureColumn(database, "devices", "siteId", "TEXT NOT NULL DEFAULT 'site.local.default'");
  ensureColumn(database, "recommendations", "updatedAt", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "playbook_runs", "updatedAt", "TEXT NOT NULL DEFAULT ''");

  database.prepare(`
    INSERT OR IGNORE INTO sites (id, slug, name, timezone, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    "site.local.default",
    "local-default",
    "Local Site",
    "America/Toronto",
  );

  database.prepare(`
    UPDATE devices
    SET siteId = 'site.local.default'
    WHERE siteId IS NULL OR TRIM(siteId) = ''
  `).run();

  database.prepare(`
    UPDATE recommendations
    SET updatedAt = COALESCE(NULLIF(updatedAt, ''), createdAt)
    WHERE updatedAt IS NULL OR TRIM(updatedAt) = ''
  `).run();

  database.prepare(`
    UPDATE playbook_runs
    SET updatedAt = COALESCE(
      NULLIF(updatedAt, ''),
      completedAt,
      deniedAt,
      approvedAt,
      startedAt,
      createdAt
    )
    WHERE updatedAt IS NULL OR TRIM(updatedAt) = ''
  `).run();

  const legacySiteNode = database
    .prepare("SELECT id FROM graph_nodes WHERE id = 'site:default'")
    .get() as { id?: string } | undefined;
  const releaseSiteNode = database
    .prepare("SELECT id FROM graph_nodes WHERE id = 'site:site.local.default'")
    .get() as { id?: string } | undefined;

  if (legacySiteNode?.id && !releaseSiteNode?.id) {
    database.prepare(`
      UPDATE graph_nodes
      SET id = 'site:site.local.default',
          properties = json_patch(COALESCE(properties, '{}'), '{"siteId":"site.local.default","slug":"local-default"}'),
          updatedAt = CURRENT_TIMESTAMP
      WHERE id = 'site:default'
    `).run();
  }

  database.prepare(`
    UPDATE graph_edges
    SET "from" = 'site:site.local.default',
        updatedAt = CURRENT_TIMESTAMP
    WHERE "from" = 'site:default'
  `).run();
  database.prepare(`
    UPDATE graph_edges
    SET "to" = 'site:site.local.default',
        updatedAt = CURRENT_TIMESTAMP
    WHERE "to" = 'site:default'
  `).run();
  database.prepare("DELETE FROM graph_nodes WHERE id = 'site:default'").run();
}

export function applyStateSchemaAndMigrations(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  createSchema(database);
  migrateProviderConfigSchema(database);
  migrateReleaseStateSchema(database);
  migrateLegacyWorkloadArchitecture(database);
  migrateCompletedOnboardingDraftCleanup(database);
  migrateLegacyWidgetJsonParsers(database);
}

export function getDb(): Database.Database {
  if (stateDb) return stateDb;

  mkdirSync(DATA_DIR, { recursive: true });
  stateDb = new Database(STATE_DB_PATH);
  try {
    applyStateSchemaAndMigrations(stateDb);
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

export function closeOpenDatabases(): void {
  closeDbQuietly();
  closeAuditDbQuietly();
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
