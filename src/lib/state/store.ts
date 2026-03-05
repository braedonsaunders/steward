import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getAuditDb,
  getAuditDbPath,
  getDb,
  getDataDir as dbGetDataDir,
  getDbPath,
  recoverCorruptAuditDatabase,
  recoverCorruptDatabase,
} from "@/lib/state/db";
import {
  defaultAuthSettings,
  defaultRuntimeSettings,
  defaultSystemSettings,
  ensureDefaults,
} from "@/lib/state/defaults";
import type {
  ActionLog,
  AdoptionQuestion,
  AdoptionRun,
  AgentRunRecord,
  AuthSettings,
  ChatMessage,
  ChatSession,
  DailyDigest,
  Device,
  DeviceAdapterBinding,
  DeviceBaseline,
  DeviceCredential,
  DeviceFinding,
  DiscoveryObservation,
  DiscoveryObservationInput,
  GraphEdge,
  GraphNode,
  Incident,
  MaintenanceWindow,
  OAuthState,
  PlaybookRun,
  PolicyRule,
  ProviderConfig,
  Recommendation,
  RuntimeSettings,
  ServiceContract,
  SettingsHistoryEntry,
  StewardState,
  SystemSettings,
} from "@/lib/state/types";

/* ---------- Row <-> Domain helpers ---------- */

function deviceFromRow(row: Record<string, unknown>): Device {
  const secondaryIps = row.secondaryIps ? JSON.parse(row.secondaryIps as string) as string[] : [];
  return {
    id: row.id as string,
    name: row.name as string,
    ip: row.ip as string,
    secondaryIps: secondaryIps.length > 0 ? secondaryIps : undefined,
    mac: (row.mac as string) ?? undefined,
    hostname: (row.hostname as string) ?? undefined,
    vendor: (row.vendor as string) ?? undefined,
    os: (row.os as string) ?? undefined,
    role: (row.role as string) ?? undefined,
    type: row.type as Device["type"],
    status: row.status as Device["status"],
    autonomyTier: row.autonomyTier as Device["autonomyTier"],
    tags: JSON.parse(row.tags as string) as string[],
    protocols: JSON.parse(row.protocols as string) as string[],
    services: JSON.parse(row.services as string) as Device["services"],
    firstSeenAt: row.firstSeenAt as string,
    lastSeenAt: row.lastSeenAt as string,
    lastChangedAt: row.lastChangedAt as string,
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function baselineFromRow(row: Record<string, unknown>): DeviceBaseline {
  return {
    deviceId: row.deviceId as string,
    avgLatencyMs: row.avgLatencyMs as number,
    maxLatencyMs: row.maxLatencyMs as number,
    minLatencyMs: row.minLatencyMs as number,
    samples: row.samples as number,
    lastUpdatedAt: row.lastUpdatedAt as string,
  };
}

function incidentFromRow(row: Record<string, unknown>): Incident {
  return {
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    severity: row.severity as Incident["severity"],
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    status: row.status as Incident["status"],
    detectedAt: row.detectedAt as string,
    updatedAt: row.updatedAt as string,
    timeline: JSON.parse(row.timeline as string) as Incident["timeline"],
    diagnosis: (row.diagnosis as string) ?? undefined,
    remediationPlan: (row.remediationPlan as string) ?? undefined,
    autoRemediated: Boolean(row.autoRemediated),
    metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
  };
}

function recommendationFromRow(row: Record<string, unknown>): Recommendation {
  return {
    id: row.id as string,
    title: row.title as string,
    rationale: row.rationale as string,
    impact: row.impact as string,
    priority: row.priority as Recommendation["priority"],
    relatedDeviceIds: JSON.parse(row.relatedDeviceIds as string) as string[],
    createdAt: row.createdAt as string,
    dismissed: Boolean(row.dismissed),
  };
}

function actionFromRow(row: Record<string, unknown>): ActionLog {
  return {
    id: row.id as string,
    at: row.at as string,
    actor: row.actor as ActionLog["actor"],
    kind: row.kind as ActionLog["kind"],
    message: row.message as string,
    context: JSON.parse(row.context as string) as Record<string, unknown>,
  };
}

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

function graphEdgeFromRow(row: Record<string, unknown>): GraphEdge {
  return {
    id: row.id as string,
    from: row.from as string,
    to: row.to as string,
    type: row.type as string,
    properties: JSON.parse(row.properties as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function providerConfigFromRow(row: Record<string, unknown>): ProviderConfig {
  const config: ProviderConfig = {
    provider: row.provider as ProviderConfig["provider"],
    enabled: Boolean(row.enabled),
    model: row.model as string,
  };
  if (row.apiKeyEnvVar) config.apiKeyEnvVar = row.apiKeyEnvVar as string;
  if (row.oauthTokenSecret) config.oauthTokenSecret = row.oauthTokenSecret as string;
  if (row.oauthClientIdEnvVar) config.oauthClientIdEnvVar = row.oauthClientIdEnvVar as string;
  if (row.oauthClientSecretEnvVar) config.oauthClientSecretEnvVar = row.oauthClientSecretEnvVar as string;
  if (row.oauthAuthUrl) config.oauthAuthUrl = row.oauthAuthUrl as string;
  if (row.oauthTokenUrl) config.oauthTokenUrl = row.oauthTokenUrl as string;
  if (row.oauthScopes) config.oauthScopes = JSON.parse(row.oauthScopes as string) as string[];
  if (row.baseUrl) config.baseUrl = row.baseUrl as string;
  if (row.extraHeaders) config.extraHeaders = JSON.parse(row.extraHeaders as string) as Record<string, string>;
  return config;
}

function oauthStateFromRow(row: Record<string, unknown>): OAuthState {
  return {
    id: row.id as string,
    provider: row.provider as OAuthState["provider"],
    redirectUri: row.redirectUri as string,
    codeVerifier: row.codeVerifier as string,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
  };
}

function agentRunFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: row.id as string,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string) ?? undefined,
    outcome: row.outcome as AgentRunRecord["outcome"],
    summary: row.summary as string,
    details: JSON.parse(row.details as string) as Record<string, unknown>,
  };
}

function policyRuleFromRow(row: Record<string, unknown>): PolicyRule {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    actionClasses: JSON.parse(row.actionClasses as string) as PolicyRule["actionClasses"],
    autonomyTiers: JSON.parse(row.autonomyTiers as string) as PolicyRule["autonomyTiers"],
    environmentLabels: JSON.parse(row.environmentLabels as string) as PolicyRule["environmentLabels"],
    deviceTypes: JSON.parse(row.deviceTypes as string) as PolicyRule["deviceTypes"],
    decision: row.decision as PolicyRule["decision"],
    priority: row.priority as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

function maintenanceWindowFromRow(row: Record<string, unknown>): MaintenanceWindow {
  return {
    id: row.id as string,
    name: row.name as string,
    deviceIds: JSON.parse(row.deviceIds as string) as string[],
    cronStart: row.cronStart as string,
    durationMinutes: row.durationMinutes as number,
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt as string,
  };
}

function playbookRunFromRow(row: Record<string, unknown>): PlaybookRun {
  const policyEvaluationRaw = JSON.parse(row.policyEvaluation as string) as Partial<PlaybookRun["policyEvaluation"]>;
  const policyInputsRaw = (policyEvaluationRaw.inputs ?? {}) as Partial<PlaybookRun["policyEvaluation"]["inputs"]>;

  return {
    id: row.id as string,
    playbookId: row.playbookId as string,
    family: row.family as PlaybookRun["family"],
    name: row.name as string,
    deviceId: row.deviceId as string,
    incidentId: (row.incidentId as string) ?? undefined,
    actionClass: row.actionClass as PlaybookRun["actionClass"],
    status: row.status as PlaybookRun["status"],
    policyEvaluation: {
      decision: (policyEvaluationRaw.decision as PlaybookRun["policyEvaluation"]["decision"]) ?? "REQUIRE_APPROVAL",
      ruleId: policyEvaluationRaw.ruleId ?? null,
      reason: String(policyEvaluationRaw.reason ?? "Policy evaluation unavailable"),
      evaluatedAt: String(policyEvaluationRaw.evaluatedAt ?? row.createdAt ?? new Date().toISOString()),
      inputs: {
        actionClass: (policyInputsRaw.actionClass as PlaybookRun["policyEvaluation"]["inputs"]["actionClass"])
          ?? (row.actionClass as PlaybookRun["actionClass"]),
        autonomyTier: (policyInputsRaw.autonomyTier as PlaybookRun["policyEvaluation"]["inputs"]["autonomyTier"]) ?? 1,
        environmentLabel: (policyInputsRaw.environmentLabel as PlaybookRun["policyEvaluation"]["inputs"]["environmentLabel"]) ?? "lab",
        inMaintenanceWindow: Boolean(policyInputsRaw.inMaintenanceWindow),
        deviceId: String(policyInputsRaw.deviceId ?? row.deviceId),
        blastRadius: (policyInputsRaw.blastRadius as PlaybookRun["policyEvaluation"]["inputs"]["blastRadius"]) ?? "single-device",
        criticality: (policyInputsRaw.criticality as PlaybookRun["policyEvaluation"]["inputs"]["criticality"]) ?? "medium",
        lane: (policyInputsRaw.lane as PlaybookRun["policyEvaluation"]["inputs"]["lane"]) ?? "A",
        recentFailures: Number(policyInputsRaw.recentFailures ?? 0),
        quarantineActive: Boolean(policyInputsRaw.quarantineActive),
      },
    },
    steps: JSON.parse(row.steps as string) as PlaybookRun["steps"],
    verificationSteps: JSON.parse(row.verificationSteps as string) as PlaybookRun["verificationSteps"],
    rollbackSteps: JSON.parse(row.rollbackSteps as string) as PlaybookRun["rollbackSteps"],
    evidence: JSON.parse(row.evidence as string) as PlaybookRun["evidence"],
    createdAt: row.createdAt as string,
    startedAt: (row.startedAt as string) ?? undefined,
    completedAt: (row.completedAt as string) ?? undefined,
    approvedBy: (row.approvedBy as string) ?? undefined,
    approvedAt: (row.approvedAt as string) ?? undefined,
    deniedBy: (row.deniedBy as string) ?? undefined,
    deniedAt: (row.deniedAt as string) ?? undefined,
    denialReason: (row.denialReason as string) ?? undefined,
    expiresAt: (row.expiresAt as string) ?? undefined,
    failureCount: row.failureCount as number,
  };
}

function dailyDigestFromRow(row: Record<string, unknown>): DailyDigest {
  const content = JSON.parse(row.content as string) as Omit<DailyDigest, "id" | "generatedAt" | "periodStart" | "periodEnd">;
  return {
    id: row.id as string,
    generatedAt: row.generatedAt as string,
    periodStart: row.periodStart as string,
    periodEnd: row.periodEnd as string,
    ...content,
  };
}

function discoveryObservationFromRow(row: Record<string, unknown>): DiscoveryObservation {
  return {
    id: row.id as string,
    ip: row.ip as string,
    deviceId: row.deviceId ? String(row.deviceId) : undefined,
    source: row.source as DiscoveryObservation["source"],
    evidenceType: row.evidenceType as DiscoveryObservation["evidenceType"],
    confidence: Number(row.confidence),
    observedAt: String(row.observedAt),
    expiresAt: String(row.expiresAt),
    details: JSON.parse(String(row.details ?? "{}")) as Record<string, unknown>,
  };
}

function adoptionRunFromRow(row: Record<string, unknown>): AdoptionRun {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    status: row.status as AdoptionRun["status"],
    stage: row.stage as AdoptionRun["stage"],
    profileJson: JSON.parse(String(row.profileJson ?? "{}")) as Record<string, unknown>,
    summary: row.summary ? String(row.summary) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function adoptionQuestionFromRow(row: Record<string, unknown>): AdoptionQuestion {
  return {
    id: String(row.id),
    runId: String(row.runId),
    deviceId: String(row.deviceId),
    questionKey: String(row.questionKey),
    prompt: String(row.prompt),
    options: JSON.parse(String(row.optionsJson ?? "[]")) as AdoptionQuestion["options"],
    required: Boolean(row.required),
    answerJson: row.answerJson ? JSON.parse(String(row.answerJson)) as Record<string, unknown> : undefined,
    answeredAt: row.answeredAt ? String(row.answeredAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceCredentialFromRow(row: Record<string, unknown>): DeviceCredential {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    protocol: String(row.protocol),
    adapterId: row.adapterId ? String(row.adapterId) : undefined,
    vaultSecretRef: String(row.vaultSecretRef),
    accountLabel: row.accountLabel ? String(row.accountLabel) : undefined,
    scopeJson: JSON.parse(String(row.scopeJson ?? "{}")) as Record<string, unknown>,
    status: row.status as DeviceCredential["status"],
    lastValidatedAt: row.lastValidatedAt ? String(row.lastValidatedAt) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceAdapterBindingFromRow(row: Record<string, unknown>): DeviceAdapterBinding {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    adapterId: String(row.adapterId),
    protocol: String(row.protocol),
    score: Number(row.score ?? 0),
    selected: Boolean(row.selected),
    reason: String(row.reason ?? ""),
    configJson: JSON.parse(String(row.configJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function serviceContractFromRow(row: Record<string, unknown>): ServiceContract {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    serviceKey: String(row.serviceKey),
    displayName: String(row.displayName),
    criticality: row.criticality as ServiceContract["criticality"],
    desiredState: row.desiredState as ServiceContract["desiredState"],
    checkIntervalSec: Number(row.checkIntervalSec ?? 60),
    policyJson: JSON.parse(String(row.policyJson ?? "{}")) as Record<string, unknown>,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function deviceFindingFromRow(row: Record<string, unknown>): DeviceFinding {
  return {
    id: String(row.id),
    deviceId: String(row.deviceId),
    dedupeKey: String(row.dedupeKey),
    findingType: String(row.findingType),
    severity: row.severity as DeviceFinding["severity"],
    title: String(row.title),
    summary: String(row.summary),
    evidenceJson: JSON.parse(String(row.evidenceJson ?? "{}")) as Record<string, unknown>,
    status: row.status as DeviceFinding["status"],
    firstSeenAt: String(row.firstSeenAt),
    lastSeenAt: String(row.lastSeenAt),
  };
}

function settingsHistoryFromRow<T = Record<string, unknown>>(row: Record<string, unknown>): SettingsHistoryEntry<T> {
  return {
    id: String(row.id),
    domain: row.domain as SettingsHistoryEntry<T>["domain"],
    version: Number(row.version),
    effectiveFrom: String(row.effectiveFrom),
    payload: JSON.parse(String(row.payload ?? "{}")) as T,
    actor: row.actor as SettingsHistoryEntry<T>["actor"],
    createdAt: String(row.createdAt),
  };
}

/* ---------- StateStore ---------- */

class StateStore {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    const db = getDb();
    ensureDefaults(db);
    const auditDb = getAuditDb();
    const row = auditDb.prepare("SELECT COUNT(*) as cnt FROM audit_events").get() as { cnt: number };
    if (row.cnt === 0) {
      const init = {
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: "steward",
        kind: "config",
        message: "Steward audit ledger initialized",
        context: "{}",
      };
      auditDb.prepare(`
        INSERT INTO audit_events (id, at, actor, kind, message, context, idempotencyKey, createdAt)
        VALUES (@id, @at, @actor, @kind, @message, @context, @idempotencyKey, @createdAt)
      `).run({
        ...init,
        idempotencyKey: init.id,
        createdAt: init.at,
      });
    }
    this.initialized = true;
  }

  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => {
      this.ensureInit();
      return operation(getDb());
    };

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }

      this.initialized = false;
      return run();
    }
  }

  private withAuditDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => operation(getAuditDb());

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptAuditDatabase(error, context)) {
        throw error;
      }
      return run();
    }
  }

  private readRecentAuditEvents(limit = 2_000): ActionLog[] {
    return this.withAuditDbRecovery("StateStore.readRecentAuditEvents", (auditDb) => {
      const rows = auditDb.prepare(`
        SELECT id, at, actor, kind, message, context
        FROM audit_events
        ORDER BY at DESC, id DESC
        LIMIT ?
      `).all(limit) as Record<string, unknown>[];
      return rows.map(actionFromRow);
    });
  }

  private getVersion(db: Database.Database): number {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 1;
  }

  private getInitializedAt(db: Database.Database): string {
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'initializedAt'").get() as { value: string } | undefined;
    return row?.value ?? new Date().toISOString();
  }

  private isValidTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }

  private coerceRuntimeSettings(raw: Partial<Record<keyof RuntimeSettings, unknown>>): RuntimeSettings {
    const defaults = defaultRuntimeSettings();
    const asPositiveInt = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };
    const asBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };
    const asStringArray = (value: unknown, fallback: string[]): string[] => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item));
      }
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return parsed.map((item) => String(item));
          }
        } catch {
          return fallback;
        }
      }
      return fallback;
    };

    return {
      agentIntervalMs: asPositiveInt(raw.agentIntervalMs, defaults.agentIntervalMs),
      deepScanIntervalMs: asPositiveInt(raw.deepScanIntervalMs, defaults.deepScanIntervalMs),
      incrementalActiveTargets: asPositiveInt(raw.incrementalActiveTargets, defaults.incrementalActiveTargets),
      deepActiveTargets: asPositiveInt(raw.deepActiveTargets, defaults.deepActiveTargets),
      incrementalPortScanHosts: asPositiveInt(raw.incrementalPortScanHosts, defaults.incrementalPortScanHosts),
      deepPortScanHosts: asPositiveInt(raw.deepPortScanHosts, defaults.deepPortScanHosts),
      llmDiscoveryLimit: asPositiveInt(raw.llmDiscoveryLimit, defaults.llmDiscoveryLimit),
      incrementalFingerprintTargets: Math.max(
        defaults.incrementalFingerprintTargets,
        asPositiveInt(raw.incrementalFingerprintTargets, defaults.incrementalFingerprintTargets),
      ),
      deepFingerprintTargets: Math.max(
        defaults.deepFingerprintTargets,
        asPositiveInt(raw.deepFingerprintTargets, defaults.deepFingerprintTargets),
      ),
      enableMdnsDiscovery: asBool(raw.enableMdnsDiscovery, defaults.enableMdnsDiscovery),
      enableSsdpDiscovery: asBool(raw.enableSsdpDiscovery, defaults.enableSsdpDiscovery),
      enableSnmpProbe: asBool(raw.enableSnmpProbe, defaults.enableSnmpProbe),
      ouiUpdateIntervalMs: asPositiveInt(raw.ouiUpdateIntervalMs, defaults.ouiUpdateIntervalMs),
      laneBEnabled: asBool(raw.laneBEnabled, defaults.laneBEnabled),
      laneBAllowedEnvironments: asStringArray(
        raw.laneBAllowedEnvironments,
        defaults.laneBAllowedEnvironments,
      ) as RuntimeSettings["laneBAllowedEnvironments"],
      laneBAllowedFamilies: asStringArray(raw.laneBAllowedFamilies, defaults.laneBAllowedFamilies),
      laneCMutationsInLab: asBool(raw.laneCMutationsInLab, defaults.laneCMutationsInLab),
      laneCMutationsInProd: asBool(raw.laneCMutationsInProd, defaults.laneCMutationsInProd),
      mutationRequireDryRunWhenSupported: asBool(
        raw.mutationRequireDryRunWhenSupported,
        defaults.mutationRequireDryRunWhenSupported,
      ),
      approvalTtlClassBMs: asPositiveInt(raw.approvalTtlClassBMs, defaults.approvalTtlClassBMs),
      approvalTtlClassCMs: asPositiveInt(raw.approvalTtlClassCMs, defaults.approvalTtlClassCMs),
      approvalTtlClassDMs: asPositiveInt(raw.approvalTtlClassDMs, defaults.approvalTtlClassDMs),
      quarantineThresholdCount: asPositiveInt(raw.quarantineThresholdCount, defaults.quarantineThresholdCount),
      quarantineThresholdWindowMs: asPositiveInt(
        raw.quarantineThresholdWindowMs,
        defaults.quarantineThresholdWindowMs,
      ),
    };
  }

  private coerceSystemSettings(raw: Partial<Record<keyof SystemSettings, unknown>>): SystemSettings {
    const defaults = defaultSystemSettings();
    const parseBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };
    const parseBoundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.floor(parsed)));
    };

    const timezoneCandidate =
      typeof raw.timezone === "string" && raw.timezone.trim().length > 0
        ? raw.timezone.trim()
        : defaults.timezone;
    const timezone = this.isValidTimezone(timezoneCandidate) ? timezoneCandidate : defaults.timezone;

    const nodeIdentity =
      typeof raw.nodeIdentity === "string" && raw.nodeIdentity.trim().length > 0
        ? raw.nodeIdentity.trim()
        : defaults.nodeIdentity;

    const upgradeChannel = raw.upgradeChannel === "preview" ? "preview" : "stable";

    return {
      nodeIdentity,
      timezone,
      digestScheduleEnabled: parseBool(raw.digestScheduleEnabled, defaults.digestScheduleEnabled),
      digestHourLocal: parseBoundedInt(raw.digestHourLocal, defaults.digestHourLocal, 0, 23),
      digestMinuteLocal: parseBoundedInt(raw.digestMinuteLocal, defaults.digestMinuteLocal, 0, 59),
      upgradeChannel,
    };
  }

  private coerceAuthSettings(raw: Partial<Record<keyof AuthSettings, unknown>>): AuthSettings {
    const defaults = defaultAuthSettings();

    const parseBool = (value: unknown, fallback: boolean): boolean => {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      return fallback;
    };

    const parseString = (value: unknown, fallback: string): string => {
      return typeof value === "string" ? value : fallback;
    };

    const parsePositiveInt = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
      return Math.floor(parsed);
    };

    const parseMode = (value: unknown): AuthSettings["mode"] => {
      if (value === "open" || value === "token" || value === "session" || value === "hybrid") {
        return value;
      }
      return defaults.mode;
    };

    const parseRole = (value: unknown, fallback: AuthSettings["oidc"]["defaultRole"]): AuthSettings["oidc"]["defaultRole"] => {
      if (
        value === "Owner"
        || value === "Admin"
        || value === "Operator"
        || value === "Auditor"
        || value === "ReadOnly"
      ) {
        return value;
      }
      return fallback;
    };

    const oidcRaw = (raw.oidc && typeof raw.oidc === "object")
      ? raw.oidc as Partial<AuthSettings["oidc"]>
      : {};
    const ldapRaw = (raw.ldap && typeof raw.ldap === "object")
      ? raw.ldap as Partial<AuthSettings["ldap"]>
      : {};

    return {
      apiTokenEnabled: parseBool(raw.apiTokenEnabled, defaults.apiTokenEnabled),
      mode: parseMode(raw.mode),
      sessionTtlHours: Math.min(24 * 30, parsePositiveInt(raw.sessionTtlHours, defaults.sessionTtlHours)),
      oidc: {
        enabled: parseBool(oidcRaw.enabled, defaults.oidc.enabled),
        issuer: parseString(oidcRaw.issuer, defaults.oidc.issuer),
        clientId: parseString(oidcRaw.clientId, defaults.oidc.clientId),
        scopes: parseString(oidcRaw.scopes, defaults.oidc.scopes),
        autoProvision: parseBool(oidcRaw.autoProvision, defaults.oidc.autoProvision),
        defaultRole: parseRole(oidcRaw.defaultRole, defaults.oidc.defaultRole),
        clientSecretConfigured: parseBool(oidcRaw.clientSecretConfigured, defaults.oidc.clientSecretConfigured),
      },
      ldap: {
        enabled: parseBool(ldapRaw.enabled, defaults.ldap.enabled),
        url: parseString(ldapRaw.url, defaults.ldap.url),
        baseDn: parseString(ldapRaw.baseDn, defaults.ldap.baseDn),
        bindDn: parseString(ldapRaw.bindDn, defaults.ldap.bindDn),
        userFilter: parseString(ldapRaw.userFilter, defaults.ldap.userFilter),
        uidAttribute: parseString(ldapRaw.uidAttribute, defaults.ldap.uidAttribute),
        autoProvision: parseBool(ldapRaw.autoProvision, defaults.ldap.autoProvision),
        defaultRole: parseRole(ldapRaw.defaultRole, defaults.ldap.defaultRole),
        bindPasswordConfigured: parseBool(
          ldapRaw.bindPasswordConfigured,
          defaults.ldap.bindPasswordConfigured,
        ),
      },
    };
  }

  private readSettingFromMetadata(db: Database.Database, key: string): string | undefined {
    const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private getLatestSettingsHistoryEntry<T = Record<string, unknown>>(
    db: Database.Database,
    domain: SettingsHistoryEntry<T>["domain"],
    asOf?: string,
  ): SettingsHistoryEntry<T> | null {
    const target = asOf ?? new Date().toISOString();
    const row = db.prepare(`
      SELECT id, domain, version, effectiveFrom, payload, actor, createdAt
      FROM settings_history
      WHERE domain = ?
        AND effectiveFrom <= ?
      ORDER BY effectiveFrom DESC, version DESC
      LIMIT 1
    `).get(domain, target) as Record<string, unknown> | undefined;
    return row ? settingsHistoryFromRow<T>(row) : null;
  }

  private appendSettingsHistory<T extends Record<string, unknown>>(
    db: Database.Database,
    domain: SettingsHistoryEntry<T>["domain"],
    payload: T,
    actor: SettingsHistoryEntry["actor"] = "user",
    effectiveFrom?: string,
  ): SettingsHistoryEntry<T> {
    const createdAt = new Date().toISOString();
    const nextVersionRow = db.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 as nextVersion FROM settings_history WHERE domain = ?",
    ).get(domain) as { nextVersion: number };

    const entry: SettingsHistoryEntry<T> = {
      id: randomUUID(),
      domain,
      version: Number(nextVersionRow.nextVersion),
      effectiveFrom: effectiveFrom ?? createdAt,
      payload,
      actor,
      createdAt,
    };

    db.prepare(`
      INSERT INTO settings_history (id, domain, version, effectiveFrom, payload, actor, createdAt)
      VALUES (@id, @domain, @version, @effectiveFrom, @payload, @actor, @createdAt)
    `).run({
      id: entry.id,
      domain: entry.domain,
      version: entry.version,
      effectiveFrom: entry.effectiveFrom,
      payload: JSON.stringify(entry.payload),
      actor: entry.actor,
      createdAt: entry.createdAt,
    });

    return entry;
  }

  private readRuntimeSettings(db: Database.Database, asOf?: string): RuntimeSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<RuntimeSettings>(db, "runtime", asOf);
    if (snapshot) {
      return this.coerceRuntimeSettings(snapshot.payload);
    }

    const rows = db.prepare("SELECT key, value FROM metadata WHERE key LIKE 'runtime.%'").all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return this.coerceRuntimeSettings({
      agentIntervalMs: map.get("runtime.agentIntervalMs"),
      deepScanIntervalMs: map.get("runtime.deepScanIntervalMs"),
      incrementalActiveTargets: map.get("runtime.incrementalActiveTargets"),
      deepActiveTargets: map.get("runtime.deepActiveTargets"),
      incrementalPortScanHosts: map.get("runtime.incrementalPortScanHosts"),
      deepPortScanHosts: map.get("runtime.deepPortScanHosts"),
      llmDiscoveryLimit: map.get("runtime.llmDiscoveryLimit"),
      incrementalFingerprintTargets: map.get("runtime.incrementalFingerprintTargets"),
      deepFingerprintTargets: map.get("runtime.deepFingerprintTargets"),
      enableMdnsDiscovery: map.get("runtime.enableMdnsDiscovery"),
      enableSsdpDiscovery: map.get("runtime.enableSsdpDiscovery"),
      enableSnmpProbe: map.get("runtime.enableSnmpProbe"),
      ouiUpdateIntervalMs: map.get("runtime.ouiUpdateIntervalMs"),
      laneBEnabled: map.get("runtime.laneBEnabled"),
      laneBAllowedEnvironments: map.get("runtime.laneBAllowedEnvironments"),
      laneBAllowedFamilies: map.get("runtime.laneBAllowedFamilies"),
      laneCMutationsInLab: map.get("runtime.laneCMutationsInLab"),
      laneCMutationsInProd: map.get("runtime.laneCMutationsInProd"),
      mutationRequireDryRunWhenSupported: map.get("runtime.mutationRequireDryRunWhenSupported"),
      approvalTtlClassBMs: map.get("runtime.approvalTtlClassBMs"),
      approvalTtlClassCMs: map.get("runtime.approvalTtlClassCMs"),
      approvalTtlClassDMs: map.get("runtime.approvalTtlClassDMs"),
      quarantineThresholdCount: map.get("runtime.quarantineThresholdCount"),
      quarantineThresholdWindowMs: map.get("runtime.quarantineThresholdWindowMs"),
    });
  }

  private readSystemSettings(db: Database.Database, asOf?: string): SystemSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<SystemSettings>(db, "system", asOf);
    if (snapshot) {
      return this.coerceSystemSettings(snapshot.payload);
    }

    return this.coerceSystemSettings({
      nodeIdentity: this.readSettingFromMetadata(db, "system.nodeIdentity"),
      timezone: this.readSettingFromMetadata(db, "system.timezone"),
      digestScheduleEnabled: this.readSettingFromMetadata(db, "system.digestScheduleEnabled"),
      digestHourLocal: this.readSettingFromMetadata(db, "system.digestHourLocal"),
      digestMinuteLocal: this.readSettingFromMetadata(db, "system.digestMinuteLocal"),
      upgradeChannel: this.readSettingFromMetadata(db, "system.upgradeChannel") as SystemSettings["upgradeChannel"] | undefined,
    });
  }

  private readAuthSettings(db: Database.Database, asOf?: string): AuthSettings {
    const snapshot = this.getLatestSettingsHistoryEntry<AuthSettings>(db, "auth", asOf);
    if (snapshot) {
      return this.coerceAuthSettings(snapshot.payload);
    }

    const hash = this.readSettingFromMetadata(db, "auth.apiTokenHash");
    const enabledRaw = this.readSettingFromMetadata(db, "auth.apiTokenEnabled");
    return this.coerceAuthSettings({
      apiTokenEnabled: Boolean(hash) || enabledRaw === "true" || enabledRaw === "1",
      mode: this.readSettingFromMetadata(db, "auth.mode"),
      sessionTtlHours: this.readSettingFromMetadata(db, "auth.sessionTtlHours"),
      oidc: {
        enabled: this.readSettingFromMetadata(db, "auth.oidc.enabled"),
        issuer: this.readSettingFromMetadata(db, "auth.oidc.issuer"),
        clientId: this.readSettingFromMetadata(db, "auth.oidc.clientId"),
        scopes: this.readSettingFromMetadata(db, "auth.oidc.scopes"),
        autoProvision: this.readSettingFromMetadata(db, "auth.oidc.autoProvision"),
        defaultRole: this.readSettingFromMetadata(db, "auth.oidc.defaultRole"),
        clientSecretConfigured: this.readSettingFromMetadata(db, "auth.oidc.clientSecretConfigured"),
      },
      ldap: {
        enabled: this.readSettingFromMetadata(db, "auth.ldap.enabled"),
        url: this.readSettingFromMetadata(db, "auth.ldap.url"),
        baseDn: this.readSettingFromMetadata(db, "auth.ldap.baseDn"),
        bindDn: this.readSettingFromMetadata(db, "auth.ldap.bindDn"),
        userFilter: this.readSettingFromMetadata(db, "auth.ldap.userFilter"),
        uidAttribute: this.readSettingFromMetadata(db, "auth.ldap.uidAttribute"),
        autoProvision: this.readSettingFromMetadata(db, "auth.ldap.autoProvision"),
        defaultRole: this.readSettingFromMetadata(db, "auth.ldap.defaultRole"),
        bindPasswordConfigured: this.readSettingFromMetadata(db, "auth.ldap.bindPasswordConfigured"),
      },
    });
  }

  getState(): Promise<StewardState> {
    const state = this.withDbRecovery("StateStore.getState", (db) => {
      const devices = (db.prepare("SELECT * FROM devices").all() as Record<string, unknown>[]).map(deviceFromRow);
      const baselines = (db.prepare("SELECT * FROM device_baselines").all() as Record<string, unknown>[]).map(baselineFromRow);
      const incidents = (db.prepare("SELECT * FROM incidents").all() as Record<string, unknown>[]).map(incidentFromRow);
      const recommendations = (db.prepare("SELECT * FROM recommendations").all() as Record<string, unknown>[]).map(recommendationFromRow);
      const actions = this.readRecentAuditEvents(2_000);
      const graphNodes = (db.prepare("SELECT * FROM graph_nodes").all() as Record<string, unknown>[]).map(graphNodeFromRow);
      const graphEdges = (db.prepare('SELECT id, "from", "to", type, properties, createdAt, updatedAt FROM graph_edges').all() as Record<string, unknown>[]).map(graphEdgeFromRow);
      const providerConfigs = (db.prepare("SELECT * FROM provider_configs").all() as Record<string, unknown>[]).map(providerConfigFromRow);
      const oauthStates = (db.prepare("SELECT * FROM oauth_states").all() as Record<string, unknown>[]).map(oauthStateFromRow);
      const agentRuns = (db.prepare("SELECT * FROM agent_runs ORDER BY startedAt DESC").all() as Record<string, unknown>[]).map(agentRunFromRow);
      const runtimeSettings = this.readRuntimeSettings(db);
      const systemSettings = this.readSystemSettings(db);
      const authSettings = this.readAuthSettings(db);
      const policyRules = (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
      const maintenanceWindows = (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
      const playbookRuns = (db.prepare("SELECT * FROM playbook_runs ORDER BY createdAt DESC").all() as Record<string, unknown>[]).map(playbookRunFromRow);
      const dailyDigests = (db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC").all() as Record<string, unknown>[]).map(dailyDigestFromRow);

      return {
        version: this.getVersion(db),
        initializedAt: this.getInitializedAt(db),
        devices,
        baselines,
        incidents,
        recommendations,
        actions,
        graph: { nodes: graphNodes, edges: graphEdges },
        providerConfigs,
        oauthStates,
        agentRuns,
        runtimeSettings,
        systemSettings,
        authSettings,
        policyRules,
        maintenanceWindows,
        playbookRuns,
        dailyDigests,
      };
    });

    return Promise.resolve(state);
  }

  async updateState(
    updater: (state: StewardState) => StewardState | Promise<StewardState>,
  ): Promise<StewardState> {
    const current = await this.getState();
    const next = await updater(current);
    this.writeFullState(next);
    return next;
  }

  private writeFullState(state: StewardState): void {
    this.withDbRecovery("StateStore.writeFullState", (db) => {
      const writeTx = db.transaction(() => {
      // Metadata
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('version', ?)").run(String(state.version));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('initializedAt', ?)").run(state.initializedAt);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.agentIntervalMs', ?)").run(String(state.runtimeSettings.agentIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepScanIntervalMs', ?)").run(String(state.runtimeSettings.deepScanIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalActiveTargets', ?)").run(String(state.runtimeSettings.incrementalActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepActiveTargets', ?)").run(String(state.runtimeSettings.deepActiveTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalPortScanHosts', ?)").run(String(state.runtimeSettings.incrementalPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepPortScanHosts', ?)").run(String(state.runtimeSettings.deepPortScanHosts));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.llmDiscoveryLimit', ?)").run(String(state.runtimeSettings.llmDiscoveryLimit));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.incrementalFingerprintTargets', ?)").run(String(state.runtimeSettings.incrementalFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.deepFingerprintTargets', ?)").run(String(state.runtimeSettings.deepFingerprintTargets));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableMdnsDiscovery', ?)").run(state.runtimeSettings.enableMdnsDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSsdpDiscovery', ?)").run(state.runtimeSettings.enableSsdpDiscovery ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.enableSnmpProbe', ?)").run(state.runtimeSettings.enableSnmpProbe ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.ouiUpdateIntervalMs', ?)").run(String(state.runtimeSettings.ouiUpdateIntervalMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBEnabled', ?)").run(state.runtimeSettings.laneBEnabled ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBAllowedEnvironments', ?)").run(JSON.stringify(state.runtimeSettings.laneBAllowedEnvironments));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneBAllowedFamilies', ?)").run(JSON.stringify(state.runtimeSettings.laneBAllowedFamilies));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneCMutationsInLab', ?)").run(state.runtimeSettings.laneCMutationsInLab ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.laneCMutationsInProd', ?)").run(state.runtimeSettings.laneCMutationsInProd ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.mutationRequireDryRunWhenSupported', ?)").run(state.runtimeSettings.mutationRequireDryRunWhenSupported ? "true" : "false");
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassBMs', ?)").run(String(state.runtimeSettings.approvalTtlClassBMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassCMs', ?)").run(String(state.runtimeSettings.approvalTtlClassCMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.approvalTtlClassDMs', ?)").run(String(state.runtimeSettings.approvalTtlClassDMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.quarantineThresholdCount', ?)").run(String(state.runtimeSettings.quarantineThresholdCount));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('runtime.quarantineThresholdWindowMs', ?)").run(String(state.runtimeSettings.quarantineThresholdWindowMs));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.nodeIdentity', ?)").run(state.systemSettings.nodeIdentity);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.timezone', ?)").run(state.systemSettings.timezone);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestScheduleEnabled', ?)").run(String(state.systemSettings.digestScheduleEnabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestHourLocal', ?)").run(String(state.systemSettings.digestHourLocal));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.digestMinuteLocal', ?)").run(String(state.systemSettings.digestMinuteLocal));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('system.upgradeChannel', ?)").run(state.systemSettings.upgradeChannel);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', ?)").run(String(state.authSettings.apiTokenEnabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.mode', ?)").run(state.authSettings.mode);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.sessionTtlHours', ?)").run(String(state.authSettings.sessionTtlHours));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.enabled', ?)").run(String(state.authSettings.oidc.enabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.issuer', ?)").run(state.authSettings.oidc.issuer);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.clientId', ?)").run(state.authSettings.oidc.clientId);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.scopes', ?)").run(state.authSettings.oidc.scopes);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.autoProvision', ?)").run(String(state.authSettings.oidc.autoProvision));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.defaultRole', ?)").run(state.authSettings.oidc.defaultRole);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.oidc.clientSecretConfigured', ?)").run(String(state.authSettings.oidc.clientSecretConfigured));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.enabled', ?)").run(String(state.authSettings.ldap.enabled));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.url', ?)").run(state.authSettings.ldap.url);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.baseDn', ?)").run(state.authSettings.ldap.baseDn);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.bindDn', ?)").run(state.authSettings.ldap.bindDn);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.userFilter', ?)").run(state.authSettings.ldap.userFilter);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.uidAttribute', ?)").run(state.authSettings.ldap.uidAttribute);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.autoProvision', ?)").run(String(state.authSettings.ldap.autoProvision));
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.defaultRole', ?)").run(state.authSettings.ldap.defaultRole);
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.ldap.bindPasswordConfigured', ?)").run(String(state.authSettings.ldap.bindPasswordConfigured));

      // Devices (upsert + delete stale; avoid full-table delete to preserve FK-linked child rows)
      const upsertDevice = db.prepare(`
        INSERT INTO devices (id, name, ip, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata, secondaryIps)
        VALUES (@id, @name, @ip, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata, @secondaryIps)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          ip = excluded.ip,
          mac = excluded.mac,
          hostname = excluded.hostname,
          vendor = excluded.vendor,
          os = excluded.os,
          role = excluded.role,
          type = excluded.type,
          status = excluded.status,
          autonomyTier = excluded.autonomyTier,
          tags = excluded.tags,
          protocols = excluded.protocols,
          services = excluded.services,
          firstSeenAt = excluded.firstSeenAt,
          lastSeenAt = excluded.lastSeenAt,
          lastChangedAt = excluded.lastChangedAt,
          metadata = excluded.metadata,
          secondaryIps = excluded.secondaryIps
      `);
      const nextDeviceIds = new Set<string>();
      for (const d of state.devices) {
        nextDeviceIds.add(d.id);
        upsertDevice.run({
          id: d.id, name: d.name, ip: d.ip, mac: d.mac ?? null, hostname: d.hostname ?? null,
          vendor: d.vendor ?? null, os: d.os ?? null, role: d.role ?? null, type: d.type,
          status: d.status, autonomyTier: d.autonomyTier, tags: JSON.stringify(d.tags),
          protocols: JSON.stringify(d.protocols), services: JSON.stringify(d.services),
          firstSeenAt: d.firstSeenAt, lastSeenAt: d.lastSeenAt, lastChangedAt: d.lastChangedAt,
          metadata: JSON.stringify(d.metadata), secondaryIps: JSON.stringify(d.secondaryIps ?? []),
        });
      }
      if (nextDeviceIds.size === 0) {
        db.prepare("DELETE FROM devices").run();
      } else {
        const placeholders = Array.from(nextDeviceIds).map(() => "?").join(",");
        db.prepare(`DELETE FROM devices WHERE id NOT IN (${placeholders})`).run(...Array.from(nextDeviceIds));
      }

      // Baselines
      db.prepare("DELETE FROM device_baselines").run();
      const insertBaseline = db.prepare(`
        INSERT INTO device_baselines (deviceId, avgLatencyMs, maxLatencyMs, minLatencyMs, samples, lastUpdatedAt)
        VALUES (@deviceId, @avgLatencyMs, @maxLatencyMs, @minLatencyMs, @samples, @lastUpdatedAt)
      `);
      for (const b of state.baselines) {
        insertBaseline.run(b);
      }

      // Incidents
      db.prepare("DELETE FROM incidents").run();
      const insertIncident = db.prepare(`
        INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
        VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
      `);
      for (const inc of state.incidents) {
        insertIncident.run({
          id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
          deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
          detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
          timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
          remediationPlan: inc.remediationPlan ?? null,
          autoRemediated: inc.autoRemediated ? 1 : 0,
          metadata: JSON.stringify(inc.metadata),
        });
      }

      // Recommendations
      db.prepare("DELETE FROM recommendations").run();
      const insertRec = db.prepare(`
        INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
        VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
      `);
      for (const r of state.recommendations) {
        insertRec.run({
          id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
          priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
          createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
        });
      }

      // Graph nodes
      db.prepare("DELETE FROM graph_nodes").run();
      const insertNode = db.prepare(`
        INSERT INTO graph_nodes (id, type, label, properties, createdAt, updatedAt)
        VALUES (@id, @type, @label, @properties, @createdAt, @updatedAt)
      `);
      for (const n of state.graph.nodes) {
        insertNode.run({
          id: n.id, type: n.type, label: n.label,
          properties: JSON.stringify(n.properties),
          createdAt: n.createdAt, updatedAt: n.updatedAt,
        });
      }

      // Graph edges
      db.prepare("DELETE FROM graph_edges").run();
      const insertEdge = db.prepare(`
        INSERT INTO graph_edges (id, "from", "to", type, properties, createdAt, updatedAt)
        VALUES (@id, @from, @to, @type, @properties, @createdAt, @updatedAt)
      `);
      for (const e of state.graph.edges) {
        insertEdge.run({
          id: e.id, from: e.from, to: e.to, type: e.type,
          properties: JSON.stringify(e.properties),
          createdAt: e.createdAt, updatedAt: e.updatedAt,
        });
      }

      // Provider configs
      db.prepare("DELETE FROM provider_configs").run();
      const insertProvider = db.prepare(`
        INSERT INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `);
      for (const p of state.providerConfigs) {
        insertProvider.run({
          provider: p.provider, enabled: p.enabled ? 1 : 0, model: p.model,
          apiKeyEnvVar: p.apiKeyEnvVar ?? null, oauthTokenSecret: p.oauthTokenSecret ?? null,
          oauthClientIdEnvVar: p.oauthClientIdEnvVar ?? null,
          oauthClientSecretEnvVar: p.oauthClientSecretEnvVar ?? null,
          oauthAuthUrl: p.oauthAuthUrl ?? null, oauthTokenUrl: p.oauthTokenUrl ?? null,
          oauthScopes: p.oauthScopes ? JSON.stringify(p.oauthScopes) : null,
          baseUrl: p.baseUrl ?? null,
          extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
        });
      }

      // OAuth states
      db.prepare("DELETE FROM oauth_states").run();
      const insertOAuth = db.prepare(`
        INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
        VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
      `);
      for (const o of state.oauthStates) {
        insertOAuth.run(o);
      }

      // Agent runs
      db.prepare("DELETE FROM agent_runs").run();
      const insertRun = db.prepare(`
        INSERT INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
        VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
      `);
      for (const r of state.agentRuns) {
        insertRun.run({
          id: r.id, startedAt: r.startedAt, completedAt: r.completedAt ?? null,
          outcome: r.outcome, summary: r.summary, details: JSON.stringify(r.details),
        });
      }

      // Policy rules
      db.prepare("DELETE FROM policy_rules").run();
      const insertPolicyRule = db.prepare(`
        INSERT INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `);
      for (const rule of state.policyRules) {
        insertPolicyRule.run({
          id: rule.id, name: rule.name, description: rule.description,
          actionClasses: JSON.stringify(rule.actionClasses ?? []),
          autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
          environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
          deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
          decision: rule.decision, priority: rule.priority,
          enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
        });
      }

      // Maintenance windows
      db.prepare("DELETE FROM maintenance_windows").run();
      const insertWindow = db.prepare(`
        INSERT INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `);
      for (const w of state.maintenanceWindows) {
        insertWindow.run({
          id: w.id, name: w.name, deviceIds: JSON.stringify(w.deviceIds),
          cronStart: w.cronStart, durationMinutes: w.durationMinutes,
          enabled: w.enabled ? 1 : 0, createdAt: w.createdAt,
        });
      }

      // Playbook runs
      db.prepare("DELETE FROM playbook_runs").run();
      const insertPlaybookRun = db.prepare(`
        INSERT INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `);
      for (const pr of state.playbookRuns) {
        insertPlaybookRun.run({
          id: pr.id, playbookId: pr.playbookId, family: pr.family, name: pr.name,
          deviceId: pr.deviceId, incidentId: pr.incidentId ?? null,
          actionClass: pr.actionClass, status: pr.status,
          policyEvaluation: JSON.stringify(pr.policyEvaluation),
          steps: JSON.stringify(pr.steps),
          verificationSteps: JSON.stringify(pr.verificationSteps),
          rollbackSteps: JSON.stringify(pr.rollbackSteps),
          evidence: JSON.stringify(pr.evidence),
          createdAt: pr.createdAt, startedAt: pr.startedAt ?? null,
          completedAt: pr.completedAt ?? null, approvedBy: pr.approvedBy ?? null,
          approvedAt: pr.approvedAt ?? null, deniedBy: pr.deniedBy ?? null,
          deniedAt: pr.deniedAt ?? null, denialReason: pr.denialReason ?? null,
          expiresAt: pr.expiresAt ?? null, failureCount: pr.failureCount,
        });
      }

      // Daily digests
      db.prepare("DELETE FROM daily_digests").run();
      const insertDigest = db.prepare(`
        INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
        VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
      `);
      for (const d of state.dailyDigests) {
        const { id, generatedAt, periodStart, periodEnd, ...content } = d;
        insertDigest.run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });
      }
      });

      writeTx();
    });
  }

  async addAction(log: Omit<ActionLog, "id" | "at">): Promise<void> {
    this.withAuditDbRecovery("StateStore.addAction", (auditDb) => {
      const entry: ActionLog = {
        id: randomUUID(),
        at: new Date().toISOString(),
        ...log,
      };

      const tx = auditDb.transaction(() => {
        auditDb.prepare(`
          INSERT INTO audit_events (id, at, actor, kind, message, context, idempotencyKey, createdAt)
          VALUES (@id, @at, @actor, @kind, @message, @context, @idempotencyKey, @createdAt)
        `).run({
          id: entry.id, at: entry.at, actor: entry.actor, kind: entry.kind,
          message: entry.message,
          context: JSON.stringify(entry.context),
          idempotencyKey: entry.id,
          createdAt: entry.at,
        });

        // Durable queue for replay guarantees.
        auditDb.prepare(`
          INSERT OR IGNORE INTO durable_jobs (id, kind, payload, status, attempts, idempotencyKey, runAfter, createdAt, updatedAt, lastError)
          VALUES (@id, @kind, @payload, 'completed', 1, @idempotencyKey, @runAfter, @createdAt, @updatedAt, NULL)
        `).run({
          id: `job:${entry.id}`,
          kind: "action_log",
          payload: JSON.stringify(entry),
          idempotencyKey: entry.id,
          runAfter: entry.at,
          createdAt: entry.at,
          updatedAt: entry.at,
        });

        // Keep max 20k rows (delete oldest beyond limit)
        auditDb.prepare(`
          DELETE FROM audit_events WHERE id NOT IN (
            SELECT id FROM audit_events ORDER BY at DESC LIMIT 20000
          )
        `).run();
      });

      tx();
    });
  }

  async upsertDevice(device: Device): Promise<Device> {
    this.withDbRecovery("StateStore.upsertDevice", (db) => {
      db.prepare(`
        INSERT INTO devices (id, name, ip, secondaryIps, mac, hostname, vendor, os, role, type, status, autonomyTier, tags, protocols, services, firstSeenAt, lastSeenAt, lastChangedAt, metadata)
        VALUES (@id, @name, @ip, @secondaryIps, @mac, @hostname, @vendor, @os, @role, @type, @status, @autonomyTier, @tags, @protocols, @services, @firstSeenAt, @lastSeenAt, @lastChangedAt, @metadata)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          ip = excluded.ip,
          secondaryIps = excluded.secondaryIps,
          mac = excluded.mac,
          hostname = excluded.hostname,
          vendor = excluded.vendor,
          os = excluded.os,
          role = excluded.role,
          type = excluded.type,
          status = excluded.status,
          autonomyTier = excluded.autonomyTier,
          tags = excluded.tags,
          protocols = excluded.protocols,
          services = excluded.services,
          firstSeenAt = excluded.firstSeenAt,
          lastSeenAt = excluded.lastSeenAt,
          lastChangedAt = excluded.lastChangedAt,
          metadata = excluded.metadata
      `).run({
        id: device.id, name: device.name, ip: device.ip,
        secondaryIps: JSON.stringify(device.secondaryIps ?? []),
        mac: device.mac ?? null, hostname: device.hostname ?? null,
        vendor: device.vendor ?? null, os: device.os ?? null, role: device.role ?? null,
        type: device.type, status: device.status, autonomyTier: device.autonomyTier,
        tags: JSON.stringify(device.tags), protocols: JSON.stringify(device.protocols),
        services: JSON.stringify(device.services), firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt, lastChangedAt: device.lastChangedAt,
        metadata: JSON.stringify(device.metadata),
      });
    });

    return device;
  }

  async setIncidents(incidents: Incident[]): Promise<void> {
    this.withDbRecovery("StateStore.setIncidents", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM incidents").run();
        const insert = db.prepare(`
          INSERT INTO incidents (id, title, summary, severity, deviceIds, status, detectedAt, updatedAt, timeline, diagnosis, remediationPlan, autoRemediated, metadata)
          VALUES (@id, @title, @summary, @severity, @deviceIds, @status, @detectedAt, @updatedAt, @timeline, @diagnosis, @remediationPlan, @autoRemediated, @metadata)
        `);
        for (const inc of incidents) {
          insert.run({
            id: inc.id, title: inc.title, summary: inc.summary, severity: inc.severity,
            deviceIds: JSON.stringify(inc.deviceIds), status: inc.status,
            detectedAt: inc.detectedAt, updatedAt: inc.updatedAt,
            timeline: JSON.stringify(inc.timeline), diagnosis: inc.diagnosis ?? null,
            remediationPlan: inc.remediationPlan ?? null,
            autoRemediated: inc.autoRemediated ? 1 : 0,
            metadata: JSON.stringify(inc.metadata),
          });
        }
      });

      tx();
    });
  }

  async setRecommendations(recommendations: Recommendation[]): Promise<void> {
    this.withDbRecovery("StateStore.setRecommendations", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM recommendations").run();
        const insert = db.prepare(`
          INSERT INTO recommendations (id, title, rationale, impact, priority, relatedDeviceIds, createdAt, dismissed)
          VALUES (@id, @title, @rationale, @impact, @priority, @relatedDeviceIds, @createdAt, @dismissed)
        `);
        for (const r of recommendations) {
          insert.run({
            id: r.id, title: r.title, rationale: r.rationale, impact: r.impact,
            priority: r.priority, relatedDeviceIds: JSON.stringify(r.relatedDeviceIds),
            createdAt: r.createdAt, dismissed: r.dismissed ? 1 : 0,
          });
        }
      });

      tx();
    });
  }

  upsertBaselines(baselines: DeviceBaseline[]): void {
    if (baselines.length === 0) {
      return;
    }
    this.withDbRecovery("StateStore.upsertBaselines", (db) => {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO device_baselines (deviceId, avgLatencyMs, maxLatencyMs, minLatencyMs, samples, lastUpdatedAt)
        VALUES (@deviceId, @avgLatencyMs, @maxLatencyMs, @minLatencyMs, @samples, @lastUpdatedAt)
      `);
      const tx = db.transaction((items: DeviceBaseline[]) => {
        for (const item of items) {
          insert.run(item);
        }
      });
      tx(baselines);
    });
  }

  async setProviderConfig(config: ProviderConfig): Promise<void> {
    this.withDbRecovery("StateStore.setProviderConfig", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO provider_configs (provider, enabled, model, apiKeyEnvVar, oauthTokenSecret, oauthClientIdEnvVar, oauthClientSecretEnvVar, oauthAuthUrl, oauthTokenUrl, oauthScopes, baseUrl, extraHeaders)
        VALUES (@provider, @enabled, @model, @apiKeyEnvVar, @oauthTokenSecret, @oauthClientIdEnvVar, @oauthClientSecretEnvVar, @oauthAuthUrl, @oauthTokenUrl, @oauthScopes, @baseUrl, @extraHeaders)
      `).run({
        provider: config.provider, enabled: config.enabled ? 1 : 0, model: config.model,
        apiKeyEnvVar: config.apiKeyEnvVar ?? null, oauthTokenSecret: config.oauthTokenSecret ?? null,
        oauthClientIdEnvVar: config.oauthClientIdEnvVar ?? null,
        oauthClientSecretEnvVar: config.oauthClientSecretEnvVar ?? null,
        oauthAuthUrl: config.oauthAuthUrl ?? null, oauthTokenUrl: config.oauthTokenUrl ?? null,
        oauthScopes: config.oauthScopes ? JSON.stringify(config.oauthScopes) : null,
        baseUrl: config.baseUrl ?? null,
        extraHeaders: config.extraHeaders ? JSON.stringify(config.extraHeaders) : null,
      });
    });
  }

  async createOAuthState(stateItem: Omit<OAuthState, "id" | "createdAt">): Promise<OAuthState> {
    return this.withDbRecovery("StateStore.createOAuthState", (db) => {
      const created: OAuthState = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...stateItem,
      };

      const tx = db.transaction(() => {
        // Clean expired states first
        db.prepare("DELETE FROM oauth_states WHERE expiresAt < ?").run(new Date().toISOString());

        // Limit to 100 entries
        db.prepare(`
          DELETE FROM oauth_states WHERE id NOT IN (
            SELECT id FROM oauth_states ORDER BY createdAt DESC LIMIT 99
          )
        `).run();

        db.prepare(`
          INSERT INTO oauth_states (id, provider, redirectUri, codeVerifier, createdAt, expiresAt)
          VALUES (@id, @provider, @redirectUri, @codeVerifier, @createdAt, @expiresAt)
        `).run(created);
      });

      tx();
      return created;
    });
  }

  async consumeOAuthState(id: string): Promise<OAuthState | undefined> {
    return this.withDbRecovery("StateStore.consumeOAuthState", (db) => {
      let result: OAuthState | undefined;

      const tx = db.transaction(() => {
        const row = db.prepare("SELECT * FROM oauth_states WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (row) {
          result = oauthStateFromRow(row);
        }
        db.prepare("DELETE FROM oauth_states WHERE id = ?").run(id);
      });

      tx();

      if (!result) return undefined;
      if (new Date(result.expiresAt).getTime() < Date.now()) return undefined;

      return result;
    });
  }

  async addAgentRun(run: AgentRunRecord): Promise<void> {
    this.withDbRecovery("StateStore.addAgentRun", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO agent_runs (id, startedAt, completedAt, outcome, summary, details)
          VALUES (@id, @startedAt, @completedAt, @outcome, @summary, @details)
        `).run({
          id: run.id, startedAt: run.startedAt, completedAt: run.completedAt ?? null,
          outcome: run.outcome, summary: run.summary, details: JSON.stringify(run.details),
        });

        // Keep max 200 rows (delete oldest beyond limit)
        db.prepare(`
          DELETE FROM agent_runs WHERE id NOT IN (
            SELECT id FROM agent_runs ORDER BY startedAt DESC LIMIT 200
          )
        `).run();
      });

      tx();
    });
  }

  getRuntimeSettings(asOf?: string): RuntimeSettings {
    return this.withDbRecovery("StateStore.getRuntimeSettings", (db) => this.readRuntimeSettings(db, asOf));
  }

  getSystemSettings(asOf?: string): SystemSettings {
    return this.withDbRecovery("StateStore.getSystemSettings", (db) => this.readSystemSettings(db, asOf));
  }

  getAuthSettings(asOf?: string): AuthSettings {
    return this.withDbRecovery("StateStore.getAuthSettings", (db) => this.readAuthSettings(db, asOf));
  }

  getApiTokenHash(): string | null {
    return this.withDbRecovery("StateStore.getApiTokenHash", (db) => {
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'auth.apiTokenHash'").get() as { value: string } | undefined;
      return row?.value ?? null;
    });
  }

  getSettingsHistory(
    domain: SettingsHistoryEntry["domain"],
    limit = 100,
  ): SettingsHistoryEntry[] {
    return this.withDbRecovery("StateStore.getSettingsHistory", (db) => {
      const rows = db.prepare(`
        SELECT id, domain, version, effectiveFrom, payload, actor, createdAt
        FROM settings_history
        WHERE domain = ?
        ORDER BY version DESC
        LIMIT ?
      `).all(domain, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
      return rows.map((row) => settingsHistoryFromRow(row));
    });
  }

  setRuntimeSettings(
    settings: RuntimeSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setRuntimeSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceRuntimeSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("runtime.agentIntervalMs", String(normalized.agentIntervalMs));
        put.run("runtime.deepScanIntervalMs", String(normalized.deepScanIntervalMs));
        put.run("runtime.incrementalActiveTargets", String(normalized.incrementalActiveTargets));
        put.run("runtime.deepActiveTargets", String(normalized.deepActiveTargets));
        put.run("runtime.incrementalPortScanHosts", String(normalized.incrementalPortScanHosts));
        put.run("runtime.deepPortScanHosts", String(normalized.deepPortScanHosts));
        put.run("runtime.llmDiscoveryLimit", String(normalized.llmDiscoveryLimit));
        put.run("runtime.incrementalFingerprintTargets", String(normalized.incrementalFingerprintTargets));
        put.run("runtime.deepFingerprintTargets", String(normalized.deepFingerprintTargets));
        put.run("runtime.enableMdnsDiscovery", String(normalized.enableMdnsDiscovery));
        put.run("runtime.enableSsdpDiscovery", String(normalized.enableSsdpDiscovery));
        put.run("runtime.enableSnmpProbe", String(normalized.enableSnmpProbe));
        put.run("runtime.ouiUpdateIntervalMs", String(normalized.ouiUpdateIntervalMs));
        put.run("runtime.laneBEnabled", String(normalized.laneBEnabled));
        put.run("runtime.laneBAllowedEnvironments", JSON.stringify(normalized.laneBAllowedEnvironments));
        put.run("runtime.laneBAllowedFamilies", JSON.stringify(normalized.laneBAllowedFamilies));
        put.run("runtime.laneCMutationsInLab", String(normalized.laneCMutationsInLab));
        put.run("runtime.laneCMutationsInProd", String(normalized.laneCMutationsInProd));
        put.run("runtime.mutationRequireDryRunWhenSupported", String(normalized.mutationRequireDryRunWhenSupported));
        put.run("runtime.approvalTtlClassBMs", String(normalized.approvalTtlClassBMs));
        put.run("runtime.approvalTtlClassCMs", String(normalized.approvalTtlClassCMs));
        put.run("runtime.approvalTtlClassDMs", String(normalized.approvalTtlClassDMs));
        put.run("runtime.quarantineThresholdCount", String(normalized.quarantineThresholdCount));
        put.run("runtime.quarantineThresholdWindowMs", String(normalized.quarantineThresholdWindowMs));
        this.appendSettingsHistory(
          db,
          "runtime",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setSystemSettings(
    settings: SystemSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setSystemSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceSystemSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("system.nodeIdentity", normalized.nodeIdentity);
        put.run("system.timezone", normalized.timezone);
        put.run("system.digestScheduleEnabled", String(normalized.digestScheduleEnabled));
        put.run("system.digestHourLocal", String(normalized.digestHourLocal));
        put.run("system.digestMinuteLocal", String(normalized.digestMinuteLocal));
        put.run("system.upgradeChannel", normalized.upgradeChannel);
        this.appendSettingsHistory(
          db,
          "system",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setApiTokenHash(
    hash: string | null,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setApiTokenHash", (db) => {
      const write = db.transaction(() => {
        if (hash) {
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenHash', ?)").run(hash);
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', 'true')").run();
        } else {
          db.prepare("DELETE FROM metadata WHERE key = 'auth.apiTokenHash'").run();
          db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('auth.apiTokenEnabled', 'false')").run();
        }
        const current = this.readAuthSettings(db);
        const authSettings: AuthSettings = {
          ...current,
          apiTokenEnabled: Boolean(hash),
        };
        this.appendSettingsHistory(
          db,
          "auth",
          authSettings as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  setAuthSettings(
    settings: AuthSettings,
    options?: { actor?: SettingsHistoryEntry["actor"]; effectiveFrom?: string },
  ): void {
    this.withDbRecovery("StateStore.setAuthSettings", (db) => {
      const write = db.transaction(() => {
        const normalized = this.coerceAuthSettings(settings);
        const put = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
        put.run("auth.apiTokenEnabled", String(normalized.apiTokenEnabled));
        put.run("auth.mode", normalized.mode);
        put.run("auth.sessionTtlHours", String(normalized.sessionTtlHours));
        put.run("auth.oidc.enabled", String(normalized.oidc.enabled));
        put.run("auth.oidc.issuer", normalized.oidc.issuer);
        put.run("auth.oidc.clientId", normalized.oidc.clientId);
        put.run("auth.oidc.scopes", normalized.oidc.scopes);
        put.run("auth.oidc.autoProvision", String(normalized.oidc.autoProvision));
        put.run("auth.oidc.defaultRole", normalized.oidc.defaultRole);
        put.run("auth.oidc.clientSecretConfigured", String(normalized.oidc.clientSecretConfigured));
        put.run("auth.ldap.enabled", String(normalized.ldap.enabled));
        put.run("auth.ldap.url", normalized.ldap.url);
        put.run("auth.ldap.baseDn", normalized.ldap.baseDn);
        put.run("auth.ldap.bindDn", normalized.ldap.bindDn);
        put.run("auth.ldap.userFilter", normalized.ldap.userFilter);
        put.run("auth.ldap.uidAttribute", normalized.ldap.uidAttribute);
        put.run("auth.ldap.autoProvision", String(normalized.ldap.autoProvision));
        put.run("auth.ldap.defaultRole", normalized.ldap.defaultRole);
        put.run("auth.ldap.bindPasswordConfigured", String(normalized.ldap.bindPasswordConfigured));
        this.appendSettingsHistory(
          db,
          "auth",
          normalized as unknown as Record<string, unknown>,
          options?.actor ?? "user",
          options?.effectiveFrom,
        );
      });
      write();
    });
  }

  addDiscoveryObservations(observations: DiscoveryObservationInput[]): void {
    if (observations.length === 0) {
      return;
    }

    this.withDbRecovery("StateStore.addDiscoveryObservations", (db) => {
      const insert = db.prepare(`
        INSERT INTO discovery_observations (id, ip, deviceId, source, evidenceType, confidence, observedAt, expiresAt, details)
        VALUES (@id, @ip, @deviceId, @source, @evidenceType, @confidence, @observedAt, @expiresAt, @details)
      `);

      const tx = db.transaction((batch: DiscoveryObservationInput[]) => {
        for (const item of batch) {
          const observedAt = item.observedAt || new Date().toISOString();
          const observedAtMs = Date.parse(observedAt);
          const expiresAt = item.expiresAt
            ?? new Date(
              (Number.isFinite(observedAtMs) ? observedAtMs : Date.now()) + Math.max(1, item.ttlMs ?? 15 * 60_000),
            ).toISOString();

          insert.run({
            id: randomUUID(),
            ip: item.ip,
            deviceId: null,
            source: item.source,
            evidenceType: item.evidenceType,
            confidence: Math.max(0, Math.min(1, item.confidence)),
            observedAt,
            expiresAt,
            details: JSON.stringify(item.details ?? {}),
          });
        }
      });

      tx(observations);
    });
  }

  getRecentDiscoveryObservationsByIp(
    ips: string[],
    options?: { sinceAt?: string; limitPerIp?: number },
  ): Map<string, DiscoveryObservation[]> {
    return this.withDbRecovery("StateStore.getRecentDiscoveryObservationsByIp", (db) => {
      const deduped = Array.from(new Set(ips.filter((ip) => ip.trim().length > 0)));
      if (deduped.length === 0) {
        return new Map();
      }

      const sinceAt = options?.sinceAt ?? new Date(Date.now() - 30 * 60_000).toISOString();
      const limitPerIp = Math.max(1, Math.min(100, options?.limitPerIp ?? 25));

      const placeholders = deduped.map((_, idx) => `@ip${idx}`).join(",");
      const params: Record<string, unknown> = { sinceAt };
      deduped.forEach((ip, idx) => { params[`ip${idx}`] = ip; });

      const rows = db.prepare(`
        SELECT id, ip, deviceId, source, evidenceType, confidence, observedAt, expiresAt, details
        FROM discovery_observations
        WHERE ip IN (${placeholders}) AND observedAt >= @sinceAt
        ORDER BY observedAt DESC
      `).all(params) as Record<string, unknown>[];

      const grouped = new Map<string, DiscoveryObservation[]>();
      for (const row of rows) {
        const observation = discoveryObservationFromRow(row);
        const existing = grouped.get(observation.ip) ?? [];
        if (existing.length < limitPerIp) {
          existing.push(observation);
          grouped.set(observation.ip, existing);
        }
      }

      return grouped;
    });
  }

  attachRecentObservationsToDevice(ip: string, deviceId: string, sinceAt?: string): void {
    this.withDbRecovery("StateStore.attachRecentObservationsToDevice", (db) => {
      const cutoff = sinceAt ?? new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      db.prepare(`
        UPDATE discovery_observations
        SET deviceId = @deviceId
        WHERE ip = @ip
          AND observedAt >= @sinceAt
          AND (deviceId IS NULL OR deviceId = '')
      `).run({
        ip,
        deviceId,
        sinceAt: cutoff,
      });
    });
  }

  pruneExpiredDiscoveryObservations(maxRows = 50_000): number {
    return this.withDbRecovery("StateStore.pruneExpiredDiscoveryObservations", (db) => {
      const nowIso = new Date().toISOString();
      const tx = db.transaction(() => {
        const expired = db.prepare("DELETE FROM discovery_observations WHERE expiresAt < ?").run(nowIso);
        db.prepare(`
          DELETE FROM discovery_observations
          WHERE id NOT IN (
            SELECT id
            FROM discovery_observations
            ORDER BY observedAt DESC
            LIMIT ?
          )
        `).run(maxRows);
        return expired.changes;
      });
      return tx();
    });
  }

  getAuditEventsPage(options?: {
    limit?: number;
    cursor?: { at: string; id: string };
    actor?: ActionLog["actor"];
    kind?: ActionLog["kind"];
    sinceAt?: string;
    untilAt?: string;
  }): { events: ActionLog[]; nextCursor: { at: string; id: string } | null } {
    return this.withAuditDbRecovery("StateStore.getAuditEventsPage", (auditDb) => {
      const limit = Math.max(1, Math.min(500, options?.limit ?? 100));
      const params: Record<string, unknown> = { limit: limit + 1 };
      const conditions: string[] = [];

      if (options?.actor) {
        conditions.push("actor = @actor");
        params.actor = options.actor;
      }
      if (options?.kind) {
        conditions.push("kind = @kind");
        params.kind = options.kind;
      }
      if (options?.sinceAt) {
        conditions.push("at >= @sinceAt");
        params.sinceAt = options.sinceAt;
      }
      if (options?.untilAt) {
        conditions.push("at <= @untilAt");
        params.untilAt = options.untilAt;
      }
      if (options?.cursor) {
        conditions.push("(at < @cursorAt OR (at = @cursorAt AND id < @cursorId))");
        params.cursorAt = options.cursor.at;
        params.cursorId = options.cursor.id;
      }

      let query = "SELECT id, at, actor, kind, message, context FROM audit_events";
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += " ORDER BY at DESC, id DESC LIMIT @limit";

      const rows = auditDb.prepare(query).all(params) as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const visibleRows = hasMore ? rows.slice(0, limit) : rows;
      const events = visibleRows.map(actionFromRow);

      if (!hasMore || events.length === 0) {
        return { events, nextCursor: null };
      }

      const tail = events[events.length - 1];
      return {
        events,
        nextCursor: { at: tail.at, id: tail.id },
      };
    });
  }

  enqueueDurableJob(kind: string, payload: Record<string, unknown>, idempotencyKey: string, runAfter?: string): void {
    this.withAuditDbRecovery("StateStore.enqueueDurableJob", (auditDb) => {
      const now = new Date().toISOString();
      auditDb.prepare(`
        INSERT OR IGNORE INTO durable_jobs (id, kind, payload, status, attempts, idempotencyKey, runAfter, createdAt, updatedAt, lastError)
        VALUES (@id, @kind, @payload, 'pending', 0, @idempotencyKey, @runAfter, @createdAt, @updatedAt, NULL)
      `).run({
        id: `job:${randomUUID()}`,
        kind,
        payload: JSON.stringify(payload),
        idempotencyKey,
        runAfter: runAfter ?? now,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  claimDurableJobs(limit = 100): Array<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    idempotencyKey?: string;
  }> {
    return this.withAuditDbRecovery("StateStore.claimDurableJobs", (auditDb) => {
      const now = new Date().toISOString();
      const rows = auditDb.prepare(`
        SELECT id, kind, payload, attempts, idempotencyKey
        FROM durable_jobs
        WHERE status = 'pending' AND runAfter <= ?
        ORDER BY createdAt ASC
        LIMIT ?
      `).all(now, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;

      const tx = auditDb.transaction((jobIds: string[]) => {
        for (const id of jobIds) {
          auditDb.prepare(`
            UPDATE durable_jobs
            SET status = 'processing', attempts = attempts + 1, updatedAt = ?
            WHERE id = ?
          `).run(now, id);
        }
      });
      tx(rows.map((row) => String(row.id)));

      return rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        payload: JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>,
        attempts: Number(row.attempts ?? 0),
        idempotencyKey: row.idempotencyKey ? String(row.idempotencyKey) : undefined,
      }));
    });
  }

  completeDurableJob(id: string): void {
    this.withAuditDbRecovery("StateStore.completeDurableJob", (auditDb) => {
      auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'completed', updatedAt = ?
        WHERE id = ?
      `).run(new Date().toISOString(), id);
    });
  }

  failDurableJob(id: string, errorMessage: string, retryAfterMs = 60_000): void {
    this.withAuditDbRecovery("StateStore.failDurableJob", (auditDb) => {
      const now = Date.now();
      auditDb.prepare(`
        UPDATE durable_jobs
        SET status = 'pending', lastError = ?, runAfter = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        errorMessage,
        new Date(now + Math.max(1_000, retryAfterMs)).toISOString(),
        new Date(now).toISOString(),
        id,
      );
    });
  }

  /* ---------- Policy Rules ---------- */

  getPolicyRules(): PolicyRule[] {
    return this.withDbRecovery("StateStore.getPolicyRules", (db) => {
      return (db.prepare("SELECT * FROM policy_rules ORDER BY priority ASC").all() as Record<string, unknown>[]).map(policyRuleFromRow);
    });
  }

  upsertPolicyRule(rule: PolicyRule): void {
    this.withDbRecovery("StateStore.upsertPolicyRule", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO policy_rules (id, name, description, actionClasses, autonomyTiers, environmentLabels, deviceTypes, decision, priority, enabled, createdAt, updatedAt)
        VALUES (@id, @name, @description, @actionClasses, @autonomyTiers, @environmentLabels, @deviceTypes, @decision, @priority, @enabled, @createdAt, @updatedAt)
      `).run({
        id: rule.id, name: rule.name, description: rule.description,
        actionClasses: JSON.stringify(rule.actionClasses ?? []),
        autonomyTiers: JSON.stringify(rule.autonomyTiers ?? []),
        environmentLabels: JSON.stringify(rule.environmentLabels ?? []),
        deviceTypes: JSON.stringify(rule.deviceTypes ?? []),
        decision: rule.decision, priority: rule.priority,
        enabled: rule.enabled ? 1 : 0, createdAt: rule.createdAt, updatedAt: rule.updatedAt,
      });
    });
  }

  deletePolicyRule(id: string): void {
    this.withDbRecovery("StateStore.deletePolicyRule", (db) => {
      db.prepare("DELETE FROM policy_rules WHERE id = ?").run(id);
    });
  }

  /* ---------- Maintenance Windows ---------- */

  getMaintenanceWindows(): MaintenanceWindow[] {
    return this.withDbRecovery("StateStore.getMaintenanceWindows", (db) => {
      return (db.prepare("SELECT * FROM maintenance_windows").all() as Record<string, unknown>[]).map(maintenanceWindowFromRow);
    });
  }

  upsertMaintenanceWindow(window: MaintenanceWindow): void {
    this.withDbRecovery("StateStore.upsertMaintenanceWindow", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO maintenance_windows (id, name, deviceIds, cronStart, durationMinutes, enabled, createdAt)
        VALUES (@id, @name, @deviceIds, @cronStart, @durationMinutes, @enabled, @createdAt)
      `).run({
        id: window.id, name: window.name, deviceIds: JSON.stringify(window.deviceIds),
        cronStart: window.cronStart, durationMinutes: window.durationMinutes,
        enabled: window.enabled ? 1 : 0, createdAt: window.createdAt,
      });
    });
  }

  deleteMaintenanceWindow(id: string): void {
    this.withDbRecovery("StateStore.deleteMaintenanceWindow", (db) => {
      db.prepare("DELETE FROM maintenance_windows WHERE id = ?").run(id);
    });
  }

  /* ---------- Playbook Runs ---------- */

  getPlaybookRuns(filter?: { status?: string; deviceId?: string }): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPlaybookRuns", (db) => {
      let query = "SELECT * FROM playbook_runs";
      const conditions: string[] = [];
      const params: Record<string, string> = {};

      if (filter?.status) {
        conditions.push("status = @status");
        params.status = filter.status;
      }
      if (filter?.deviceId) {
        conditions.push("deviceId = @deviceId");
        params.deviceId = filter.deviceId;
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY createdAt DESC LIMIT 500";

      return (db.prepare(query).all(params) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  getPlaybookRunById(id: string): PlaybookRun | undefined {
    return this.withDbRecovery("StateStore.getPlaybookRunById", (db) => {
      const row = db.prepare("SELECT * FROM playbook_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? playbookRunFromRow(row) : undefined;
    });
  }

  upsertPlaybookRun(run: PlaybookRun): void {
    this.withDbRecovery("StateStore.upsertPlaybookRun", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO playbook_runs (id, playbookId, family, name, deviceId, incidentId, actionClass, status, policyEvaluation, steps, verificationSteps, rollbackSteps, evidence, createdAt, startedAt, completedAt, approvedBy, approvedAt, deniedBy, deniedAt, denialReason, expiresAt, failureCount)
        VALUES (@id, @playbookId, @family, @name, @deviceId, @incidentId, @actionClass, @status, @policyEvaluation, @steps, @verificationSteps, @rollbackSteps, @evidence, @createdAt, @startedAt, @completedAt, @approvedBy, @approvedAt, @deniedBy, @deniedAt, @denialReason, @expiresAt, @failureCount)
      `).run({
        id: run.id, playbookId: run.playbookId, family: run.family, name: run.name,
        deviceId: run.deviceId, incidentId: run.incidentId ?? null,
        actionClass: run.actionClass, status: run.status,
        policyEvaluation: JSON.stringify(run.policyEvaluation),
        steps: JSON.stringify(run.steps),
        verificationSteps: JSON.stringify(run.verificationSteps),
        rollbackSteps: JSON.stringify(run.rollbackSteps),
        evidence: JSON.stringify(run.evidence),
        createdAt: run.createdAt, startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null, approvedBy: run.approvedBy ?? null,
        approvedAt: run.approvedAt ?? null, deniedBy: run.deniedBy ?? null,
        deniedAt: run.deniedAt ?? null, denialReason: run.denialReason ?? null,
        expiresAt: run.expiresAt ?? null, failureCount: run.failureCount,
      });
    });
  }

  getPendingApprovals(): PlaybookRun[] {
    return this.withDbRecovery("StateStore.getPendingApprovals", (db) => {
      const now = new Date().toISOString();
      return (db.prepare(
        "SELECT * FROM playbook_runs WHERE status = 'pending_approval' AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY createdAt ASC",
      ).all(now) as Record<string, unknown>[]).map(playbookRunFromRow);
    });
  }

  /* ---------- Daily Digests ---------- */

  addDigest(digest: DailyDigest): void {
    this.withDbRecovery("StateStore.addDigest", (db) => {
      const { id, generatedAt, periodStart, periodEnd, ...content } = digest;
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO daily_digests (id, generatedAt, periodStart, periodEnd, content)
          VALUES (@id, @generatedAt, @periodStart, @periodEnd, @content)
        `).run({
          id, generatedAt, periodStart, periodEnd,
          content: JSON.stringify(content),
        });

        // Keep max 90 digests
        db.prepare(`
          DELETE FROM daily_digests WHERE id NOT IN (
            SELECT id FROM daily_digests ORDER BY generatedAt DESC LIMIT 90
          )
        `).run();
      });
      tx();
    });
  }

  getLatestDigest(): DailyDigest | null {
    return this.withDbRecovery("StateStore.getLatestDigest", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests ORDER BY generatedAt DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  getDigestById(id: string): DailyDigest | null {
    return this.withDbRecovery("StateStore.getDigestById", (db) => {
      const row = db.prepare("SELECT * FROM daily_digests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? dailyDigestFromRow(row) : null;
    });
  }

  /* ---------- Chat Sessions & Messages ---------- */

  getChatSessions(): ChatSession[] {
    return this.withDbRecovery("StateStore.getChatSessions", (db) => {
      return (db.prepare("SELECT * FROM chat_sessions ORDER BY updatedAt DESC").all() as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          title: row.title as string,
          deviceId: (row.deviceId as string) ?? undefined,
          provider: (row.provider as string) ?? undefined,
          model: (row.model as string) ?? undefined,
          createdAt: row.createdAt as string,
          updatedAt: row.updatedAt as string,
        }),
      );
    });
  }

  getChatSessionById(id: string): ChatSession | null {
    return this.withDbRecovery("StateStore.getChatSessionById", (db) => {
      const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        title: row.title as string,
        deviceId: (row.deviceId as string) ?? undefined,
        provider: (row.provider as string) ?? undefined,
        model: (row.model as string) ?? undefined,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
      };
    });
  }

  getChatMessages(sessionId: string): ChatMessage[] {
    return this.withDbRecovery("StateStore.getChatMessages", (db) => {
      return (db.prepare("SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC").all(sessionId) as Record<string, unknown>[]).map(
        (row) => ({
          id: row.id as string,
          sessionId: row.sessionId as string,
          role: row.role as ChatMessage["role"],
          content: row.content as string,
          provider: (row.provider as string) ?? undefined,
          error: Boolean(row.error),
          createdAt: row.createdAt as string,
        }),
      );
    });
  }

  createChatSession(session: ChatSession): void {
    this.withDbRecovery("StateStore.createChatSession", (db) => {
      db.prepare(`
        INSERT INTO chat_sessions (id, title, deviceId, provider, model, createdAt, updatedAt)
        VALUES (@id, @title, @deviceId, @provider, @model, @createdAt, @updatedAt)
      `).run({
        id: session.id,
        title: session.title,
        deviceId: session.deviceId ?? null,
        provider: session.provider ?? null,
        model: session.model ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    });
  }

  addChatMessage(message: ChatMessage): void {
    this.withDbRecovery("StateStore.addChatMessage", (db) => {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO chat_messages (id, sessionId, role, content, provider, error, createdAt)
          VALUES (@id, @sessionId, @role, @content, @provider, @error, @createdAt)
        `).run({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          provider: message.provider ?? null,
          error: message.error ? 1 : 0,
          createdAt: message.createdAt,
        });

        // Touch the session's updatedAt
        db.prepare("UPDATE chat_sessions SET updatedAt = ? WHERE id = ?").run(
          message.createdAt,
          message.sessionId,
        );
      });
      tx();
    });
  }

  updateChatSessionTitle(id: string, title: string): void {
    this.withDbRecovery("StateStore.updateChatSessionTitle", (db) => {
      db.prepare("UPDATE chat_sessions SET title = ?, updatedAt = ? WHERE id = ?").run(
        title,
        new Date().toISOString(),
        id,
      );
    });
  }

  updateChatSessionDevice(id: string, deviceId?: string): void {
    this.withDbRecovery("StateStore.updateChatSessionDevice", (db) => {
      db.prepare("UPDATE chat_sessions SET deviceId = ?, updatedAt = ? WHERE id = ?").run(
        deviceId ?? null,
        new Date().toISOString(),
        id,
      );
    });
  }

  deleteChatSession(id: string): void {
    this.withDbRecovery("StateStore.deleteChatSession", (db) => {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM chat_messages WHERE sessionId = ?").run(id);
        db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
      });
      tx();
    });
  }

  getDeviceById(id: string): Device | null {
    return this.withDbRecovery("StateStore.getDeviceById", (db) => {
      const row = db.prepare("SELECT * FROM devices WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? deviceFromRow(row) : null;
    });
  }

  /* ---------- Device Adoption ---------- */

  getLatestAdoptionRun(deviceId: string): AdoptionRun | null {
    return this.withDbRecovery("StateStore.getLatestAdoptionRun", (db) => {
      const row = db.prepare(
        "SELECT * FROM adoption_runs WHERE deviceId = ? ORDER BY updatedAt DESC LIMIT 1",
      ).get(deviceId) as Record<string, unknown> | undefined;
      return row ? adoptionRunFromRow(row) : null;
    });
  }

  getAdoptionRunById(id: string): AdoptionRun | null {
    return this.withDbRecovery("StateStore.getAdoptionRunById", (db) => {
      const row = db.prepare("SELECT * FROM adoption_runs WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? adoptionRunFromRow(row) : null;
    });
  }

  upsertAdoptionRun(run: AdoptionRun): AdoptionRun {
    return this.withDbRecovery("StateStore.upsertAdoptionRun", (db) => {
      db.prepare(`
        INSERT INTO adoption_runs (id, deviceId, status, stage, profileJson, summary, createdAt, updatedAt)
        VALUES (@id, @deviceId, @status, @stage, @profileJson, @summary, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          deviceId = excluded.deviceId,
          status = excluded.status,
          stage = excluded.stage,
          profileJson = excluded.profileJson,
          summary = excluded.summary,
          createdAt = excluded.createdAt,
          updatedAt = excluded.updatedAt
      `).run({
        id: run.id,
        deviceId: run.deviceId,
        status: run.status,
        stage: run.stage,
        profileJson: JSON.stringify(run.profileJson ?? {}),
        summary: run.summary ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      return run;
    });
  }

  getAdoptionQuestions(
    deviceId: string,
    options?: { runId?: string; unresolvedOnly?: boolean },
  ): AdoptionQuestion[] {
    return this.withDbRecovery("StateStore.getAdoptionQuestions", (db) => {
      const conditions = ["deviceId = @deviceId"];
      const params: Record<string, unknown> = { deviceId };

      if (options?.runId) {
        conditions.push("runId = @runId");
        params.runId = options.runId;
      }
      if (options?.unresolvedOnly) {
        conditions.push("answerJson IS NULL");
      }

      const rows = db.prepare(`
        SELECT * FROM adoption_questions
        WHERE ${conditions.join(" AND ")}
        ORDER BY required DESC, createdAt ASC
      `).all(params) as Record<string, unknown>[];

      return rows.map(adoptionQuestionFromRow);
    });
  }

  deleteAdoptionQuestionsForRun(runId: string): void {
    this.withDbRecovery("StateStore.deleteAdoptionQuestionsForRun", (db) => {
      db.prepare("DELETE FROM adoption_questions WHERE runId = ?").run(runId);
    });
  }

  upsertAdoptionQuestion(question: AdoptionQuestion): AdoptionQuestion {
    return this.withDbRecovery("StateStore.upsertAdoptionQuestion", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO adoption_questions (
          id, runId, deviceId, questionKey, prompt, optionsJson, required, answerJson, answeredAt, createdAt, updatedAt
        )
        VALUES (
          @id, @runId, @deviceId, @questionKey, @prompt, @optionsJson, @required, @answerJson, @answeredAt, @createdAt, @updatedAt
        )
      `).run({
        id: question.id,
        runId: question.runId,
        deviceId: question.deviceId,
        questionKey: question.questionKey,
        prompt: question.prompt,
        optionsJson: JSON.stringify(question.options ?? []),
        required: question.required ? 1 : 0,
        answerJson: question.answerJson ? JSON.stringify(question.answerJson) : null,
        answeredAt: question.answeredAt ?? null,
        createdAt: question.createdAt,
        updatedAt: question.updatedAt,
      });
      return question;
    });
  }

  answerAdoptionQuestion(questionId: string, answerJson: Record<string, unknown>): AdoptionQuestion | null {
    return this.withDbRecovery("StateStore.answerAdoptionQuestion", (db) => {
      const existing = db.prepare("SELECT * FROM adoption_questions WHERE id = ?").get(questionId) as Record<string, unknown> | undefined;
      if (!existing) {
        return null;
      }

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE adoption_questions
        SET answerJson = @answerJson,
            answeredAt = @answeredAt,
            updatedAt = @updatedAt
        WHERE id = @id
      `).run({
        id: questionId,
        answerJson: JSON.stringify(answerJson),
        answeredAt: now,
        updatedAt: now,
      });

      const updated = db.prepare("SELECT * FROM adoption_questions WHERE id = ?").get(questionId) as Record<string, unknown>;
      return adoptionQuestionFromRow(updated);
    });
  }

  /* ---------- Device Credentials ---------- */

  getDeviceCredentials(deviceId: string): DeviceCredential[] {
    return this.withDbRecovery("StateStore.getDeviceCredentials", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_credentials
        WHERE deviceId = ?
        ORDER BY updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceCredentialFromRow);
    });
  }

  getDeviceCredentialById(id: string): DeviceCredential | null {
    return this.withDbRecovery("StateStore.getDeviceCredentialById", (db) => {
      const row = db.prepare("SELECT * FROM device_credentials WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? deviceCredentialFromRow(row) : null;
    });
  }

  upsertDeviceCredential(credential: DeviceCredential): DeviceCredential {
    return this.withDbRecovery("StateStore.upsertDeviceCredential", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_credentials (
          id, deviceId, protocol, adapterId, vaultSecretRef, accountLabel, scopeJson, status, lastValidatedAt, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @protocol, @adapterId, @vaultSecretRef, @accountLabel, @scopeJson, @status, @lastValidatedAt, @createdAt, @updatedAt
        )
      `).run({
        id: credential.id,
        deviceId: credential.deviceId,
        protocol: credential.protocol,
        adapterId: credential.adapterId ?? null,
        vaultSecretRef: credential.vaultSecretRef,
        accountLabel: credential.accountLabel ?? null,
        scopeJson: JSON.stringify(credential.scopeJson ?? {}),
        status: credential.status,
        lastValidatedAt: credential.lastValidatedAt ?? null,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      });
      return credential;
    });
  }

  getValidatedCredentialProtocols(deviceId: string): string[] {
    return this.withDbRecovery("StateStore.getValidatedCredentialProtocols", (db) => {
      const rows = db.prepare(`
        SELECT DISTINCT protocol
        FROM device_credentials
        WHERE deviceId = ?
          AND status IN ('provided', 'validated')
      `).all(deviceId) as Array<{ protocol: string }>;
      return rows.map((row) => String(row.protocol));
    });
  }

  /* ---------- Device Adapter Bindings ---------- */

  getDeviceAdapterBindings(deviceId: string): DeviceAdapterBinding[] {
    return this.withDbRecovery("StateStore.getDeviceAdapterBindings", (db) => {
      const rows = db.prepare(`
        SELECT * FROM device_adapter_bindings
        WHERE deviceId = ?
        ORDER BY selected DESC, score DESC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(deviceAdapterBindingFromRow);
    });
  }

  upsertDeviceAdapterBinding(binding: DeviceAdapterBinding): DeviceAdapterBinding {
    return this.withDbRecovery("StateStore.upsertDeviceAdapterBinding", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_adapter_bindings (
          id, deviceId, adapterId, protocol, score, selected, reason, configJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @adapterId, @protocol, @score, @selected, @reason, @configJson, @createdAt, @updatedAt
        )
      `).run({
        id: binding.id,
        deviceId: binding.deviceId,
        adapterId: binding.adapterId,
        protocol: binding.protocol,
        score: binding.score,
        selected: binding.selected ? 1 : 0,
        reason: binding.reason,
        configJson: JSON.stringify(binding.configJson ?? {}),
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
      return binding;
    });
  }

  clearDeviceAdapterBindings(deviceId: string): void {
    this.withDbRecovery("StateStore.clearDeviceAdapterBindings", (db) => {
      db.prepare("DELETE FROM device_adapter_bindings WHERE deviceId = ?").run(deviceId);
    });
  }

  selectDeviceAdapterBinding(deviceId: string, adapterId: string, protocol: string): void {
    this.withDbRecovery("StateStore.selectDeviceAdapterBinding", (db) => {
      const now = new Date().toISOString();
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE device_adapter_bindings
          SET selected = 0, updatedAt = ?
          WHERE deviceId = ? AND protocol = ?
        `).run(now, deviceId, protocol);
        db.prepare(`
          UPDATE device_adapter_bindings
          SET selected = 1, updatedAt = ?
          WHERE deviceId = ? AND adapterId = ? AND protocol = ?
        `).run(now, deviceId, adapterId, protocol);
      });
      tx();
    });
  }

  /* ---------- Service Contracts ---------- */

  getServiceContracts(deviceId: string): ServiceContract[] {
    return this.withDbRecovery("StateStore.getServiceContracts", (db) => {
      const rows = db.prepare(`
        SELECT * FROM service_contracts
        WHERE deviceId = ?
        ORDER BY criticality DESC, updatedAt DESC
      `).all(deviceId) as Record<string, unknown>[];
      return rows.map(serviceContractFromRow);
    });
  }

  upsertServiceContract(contract: ServiceContract): ServiceContract {
    return this.withDbRecovery("StateStore.upsertServiceContract", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO service_contracts (
          id, deviceId, serviceKey, displayName, criticality, desiredState, checkIntervalSec, policyJson, createdAt, updatedAt
        )
        VALUES (
          @id, @deviceId, @serviceKey, @displayName, @criticality, @desiredState, @checkIntervalSec, @policyJson, @createdAt, @updatedAt
        )
      `).run({
        id: contract.id,
        deviceId: contract.deviceId,
        serviceKey: contract.serviceKey,
        displayName: contract.displayName,
        criticality: contract.criticality,
        desiredState: contract.desiredState,
        checkIntervalSec: contract.checkIntervalSec,
        policyJson: JSON.stringify(contract.policyJson ?? {}),
        createdAt: contract.createdAt,
        updatedAt: contract.updatedAt,
      });
      return contract;
    });
  }

  clearServiceContracts(deviceId: string): void {
    this.withDbRecovery("StateStore.clearServiceContracts", (db) => {
      db.prepare("DELETE FROM service_contracts WHERE deviceId = ?").run(deviceId);
    });
  }

  /* ---------- Device Findings ---------- */

  getDeviceFindings(deviceId: string, status?: DeviceFinding["status"]): DeviceFinding[] {
    return this.withDbRecovery("StateStore.getDeviceFindings", (db) => {
      const params: Record<string, unknown> = { deviceId };
      let query = "SELECT * FROM device_findings WHERE deviceId = @deviceId";
      if (status) {
        query += " AND status = @status";
        params.status = status;
      }
      query += " ORDER BY lastSeenAt DESC";
      const rows = db.prepare(query).all(params) as Record<string, unknown>[];
      return rows.map(deviceFindingFromRow);
    });
  }

  upsertDeviceFinding(finding: DeviceFinding): DeviceFinding {
    return this.withDbRecovery("StateStore.upsertDeviceFinding", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO device_findings (
          id, deviceId, dedupeKey, findingType, severity, title, summary, evidenceJson, status, firstSeenAt, lastSeenAt
        )
        VALUES (
          @id, @deviceId, @dedupeKey, @findingType, @severity, @title, @summary, @evidenceJson, @status, @firstSeenAt, @lastSeenAt
        )
      `).run({
        id: finding.id,
        deviceId: finding.deviceId,
        dedupeKey: finding.dedupeKey,
        findingType: finding.findingType,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        evidenceJson: JSON.stringify(finding.evidenceJson ?? {}),
        status: finding.status,
        firstSeenAt: finding.firstSeenAt,
        lastSeenAt: finding.lastSeenAt,
      });
      return finding;
    });
  }

  upsertDeviceFindingByDedupe(
    finding: Omit<DeviceFinding, "id" | "firstSeenAt" | "lastSeenAt"> & {
      id?: string;
      firstSeenAt?: string;
      lastSeenAt?: string;
    },
  ): DeviceFinding {
    return this.withDbRecovery("StateStore.upsertDeviceFindingByDedupe", (db) => {
      const existing = db.prepare(`
        SELECT * FROM device_findings
        WHERE deviceId = ? AND dedupeKey = ?
        LIMIT 1
      `).get(finding.deviceId, finding.dedupeKey) as Record<string, unknown> | undefined;

      const now = new Date().toISOString();
      const next: DeviceFinding = {
        id: existing?.id ? String(existing.id) : (finding.id ?? randomUUID()),
        deviceId: finding.deviceId,
        dedupeKey: finding.dedupeKey,
        findingType: finding.findingType,
        severity: finding.severity,
        title: finding.title,
        summary: finding.summary,
        evidenceJson: finding.evidenceJson,
        status: finding.status,
        firstSeenAt: existing?.firstSeenAt ? String(existing.firstSeenAt) : (finding.firstSeenAt ?? now),
        lastSeenAt: finding.lastSeenAt ?? now,
      };

      db.prepare(`
        INSERT OR REPLACE INTO device_findings (
          id, deviceId, dedupeKey, findingType, severity, title, summary, evidenceJson, status, firstSeenAt, lastSeenAt
        )
        VALUES (
          @id, @deviceId, @dedupeKey, @findingType, @severity, @title, @summary, @evidenceJson, @status, @firstSeenAt, @lastSeenAt
        )
      `).run({
        id: next.id,
        deviceId: next.deviceId,
        dedupeKey: next.dedupeKey,
        findingType: next.findingType,
        severity: next.severity,
        title: next.title,
        summary: next.summary,
        evidenceJson: JSON.stringify(next.evidenceJson ?? {}),
        status: next.status,
        firstSeenAt: next.firstSeenAt,
        lastSeenAt: next.lastSeenAt,
      });

      return next;
    });
  }

  getDataDir(): string {
    return dbGetDataDir();
  }

  getStateFile(): string {
    return getDbPath();
  }

  getAuditStateFile(): string {
    return getAuditDbPath();
  }
}

export const stateStore = new StateStore();
