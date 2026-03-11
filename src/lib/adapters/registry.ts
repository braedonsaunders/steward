import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { getDataDir, getDb } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import { readManifest, loadAdapterModule, parseManifest } from "@/lib/adapters/loader";
import {
  DEFAULT_ADAPTER_SKILL_MD_PATH,
  buildAdapterSkillMarkdown,
  buildToolSkillMarkdown,
  defaultToolSkillMarkdownPath,
  normalizeToolSkills,
} from "@/lib/adapters/skills";
import {
  type AdapterManifest,
  type AdapterWebFlowRecipe,
  type AdapterProfileMatch,
  type AdapterSkillMarkdown,
  type AdapterRecord,
  type AdapterCapability,
  type AdapterConfigField,
  type AdapterRuntimeContext,
  type AdapterSource,
  type AdapterToolSkill,
  type StewardAdapter,
} from "@/lib/adapters/types";
import { BUILTIN_ADAPTERS } from "@/lib/adapters/starter-pack";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { Device, PlaybookDefinition } from "@/lib/state/types";
import type { ManagementCapability } from "@/lib/protocols/negotiator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MARKDOWN_ATTACHMENT_CHARS = 24_000;
const BUILTIN_ADAPTER_IDS = new Set(BUILTIN_ADAPTERS.map((bundle) => bundle.manifest.id));

export interface AdapterPackageRecord {
  adapter: AdapterRecord;
  manifest: AdapterManifest;
  entrySource: string;
  adapterSkillMd?: string;
  toolSkillMd: Record<string, string>;
  isBuiltin: boolean;
}

export interface DeviceWebFlowBinding {
  adapterId: string;
  adapterName: string;
  profileMatch?: AdapterProfileMatch;
  flow: AdapterWebFlowRecipe;
}

export interface AdapterPackageMutation {
  manifest: unknown;
  entrySource: string;
  adapterSkillMd?: string;
  toolSkillMd?: Record<string, string>;
}

interface AdapterMutationOptions {
  actor?: "user" | "steward";
}

function adaptersDir(): string {
  const dir = path.join(getDataDir(), "adapters");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function adapterPath(dirName: string): string {
  return path.join(adaptersDir(), dirName);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function safeArray<T>(value: unknown): T[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function asAdapterSource(value: unknown): AdapterSource {
  return value === "managed" ? "managed" : "file";
}

function sanitizeMarkdownPath(relativePath: string | undefined): string | undefined {
  if (typeof relativePath !== "string") {
    return undefined;
  }

  const trimmed = relativePath.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!trimmed.toLowerCase().endsWith(".md")) {
    return undefined;
  }

  return trimmed;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "adapter";
}

function normalizeMutationActor(actor: "user" | "steward" | undefined): "user" | "steward" {
  return actor === "steward" ? "steward" : "user";
}

function safeReadMarkdownAttachment(
  adapterDir: string | undefined,
  relativePath: string | undefined,
): AdapterSkillMarkdown | undefined {
  const safePath = sanitizeMarkdownPath(relativePath);
  if (!adapterDir || !safePath) {
    return undefined;
  }

  const root = path.resolve(adapterDir);
  const resolved = path.resolve(root, safePath);
  if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    return undefined;
  }

  if (!existsSync(resolved)) {
    return undefined;
  }

  const raw = readFileSync(resolved, "utf-8");
  if (raw.length <= MAX_MARKDOWN_ATTACHMENT_CHARS) {
    return { path: safePath, content: raw };
  }

  return {
    path: safePath,
    content: `${raw.slice(0, MAX_MARKDOWN_ATTACHMENT_CHARS)}\n\n...[truncated]`,
    truncated: true,
  };
}

function resolveSafeChildPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, relativePath);
  if (!(resolvedChild === resolvedRoot || resolvedChild.startsWith(`${resolvedRoot}${path.sep}`))) {
    throw new Error(`Unsafe adapter file path: ${relativePath}`);
  }
  return resolvedChild;
}

function readFileIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  return readFileSync(filePath, "utf-8");
}

function parseManifestMutation(
  manifestInput: unknown,
): AdapterManifest {
  const parsed = parseManifest(manifestInput);
  const normalized: AdapterManifest = {
    ...parsed,
    skillMdPath: sanitizeMarkdownPath(parsed.skillMdPath) ?? DEFAULT_ADAPTER_SKILL_MD_PATH,
  };
  normalized.toolSkills = normalizeManifestToolSkills(normalized);
  return normalized;
}

function ensureRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function writeAdapterPackageFiles(
  targetDir: string,
  mutation: AdapterPackageMutation,
): void {
  const manifest = parseManifestMutation(mutation.manifest);
  const entrySource = mutation.entrySource.trim();
  if (!entrySource) {
    throw new Error("Adapter entrySource must not be empty");
  }

  mkdirSync(targetDir, { recursive: true });
  const manifestPath = resolveSafeChildPath(targetDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  const entryRelative = manifest.entry ?? "index.js";
  const entryPath = resolveSafeChildPath(targetDir, entryRelative);
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, entrySource, "utf-8");

  const adapterSkillRelative = manifest.skillMdPath ?? DEFAULT_ADAPTER_SKILL_MD_PATH;
  const adapterSkillPath = resolveSafeChildPath(targetDir, adapterSkillRelative);
  mkdirSync(path.dirname(adapterSkillPath), { recursive: true });
  writeFileSync(
    adapterSkillPath,
    mutation.adapterSkillMd?.trim() || buildAdapterSkillMarkdown(manifest),
    "utf-8",
  );

  const toolMd = ensureRecord(mutation.toolSkillMd ?? {}, "toolSkillMd");
  for (const skill of manifest.toolSkills ?? []) {
    const skillPathRelative = sanitizeMarkdownPath(skill.skillMdPath) ?? defaultToolSkillMarkdownPath(skill.id);
    const skillPath = resolveSafeChildPath(targetDir, skillPathRelative);
    mkdirSync(path.dirname(skillPath), { recursive: true });
    const provided = toolMd[skill.id];
    const content = typeof provided === "string" && provided.trim().length > 0
      ? provided
      : buildToolSkillMarkdown(skill);
    writeFileSync(skillPath, content, "utf-8");
  }
}

function normalizeManifestToolSkills(manifest: AdapterManifest): AdapterToolSkill[] {
  return normalizeToolSkills(manifest.toolSkills).map((skill) => ({
    ...skill,
    skillMdPath: sanitizeMarkdownPath(skill.skillMdPath) ?? defaultToolSkillMarkdownPath(skill.id),
  }));
}

function buildManifestFromRow(row: Record<string, unknown>): AdapterManifest {
  const manifestFromRow = safeObject(row.manifestJson);
  const configSchema = safeArray<AdapterConfigField>(row.configSchema);
  const toolSkills = normalizeToolSkills(safeArray<AdapterToolSkill>(row.toolSkills));

  const manifest: AdapterManifest = {
    id: String(manifestFromRow.id ?? row.id ?? ""),
    name: String(manifestFromRow.name ?? row.name ?? "Unnamed Adapter"),
    description: String(manifestFromRow.description ?? row.description ?? ""),
    version: String(manifestFromRow.version ?? row.version ?? "0.0.0"),
    author: String(manifestFromRow.author ?? row.author ?? ""),
    entry: String(manifestFromRow.entry ?? "index.js"),
    provides: (Array.isArray(manifestFromRow.provides)
      ? manifestFromRow.provides
      : safeArray<AdapterCapability>(row.provides)) as AdapterCapability[],
    configSchema: Array.isArray(manifestFromRow.configSchema)
      ? manifestFromRow.configSchema as AdapterConfigField[]
      : configSchema,
    defaultConfig: isRecord(manifestFromRow.defaultConfig)
      ? manifestFromRow.defaultConfig
      : {},
    toolSkills: Array.isArray(manifestFromRow.toolSkills)
      ? normalizeToolSkills(manifestFromRow.toolSkills as AdapterToolSkill[])
      : toolSkills,
    defaultToolConfig: isRecord(manifestFromRow.defaultToolConfig)
      ? manifestFromRow.defaultToolConfig as Record<string, Record<string, unknown>>
      : {},
    docsUrl: typeof manifestFromRow.docsUrl === "string"
      ? manifestFromRow.docsUrl
      : (row.docsUrl ? String(row.docsUrl) : undefined),
    skillMdPath: sanitizeMarkdownPath(
      typeof manifestFromRow.skillMdPath === "string" ? manifestFromRow.skillMdPath : undefined,
    ) ?? DEFAULT_ADAPTER_SKILL_MD_PATH,
  };

  manifest.toolSkills = normalizeManifestToolSkills(manifest);
  return manifest;
}

function defaultsFromManifest(manifest: AdapterManifest): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    ...(manifest.defaultConfig ?? {}),
  };

  for (const field of manifest.configSchema ?? []) {
    if (defaults[field.key] === undefined && field.default !== undefined) {
      defaults[field.key] = field.default;
    }
  }

  return defaults;
}

function normalizeConfig(manifest: AdapterManifest, value: unknown): Record<string, unknown> {
  return {
    ...defaultsFromManifest(manifest),
    ...safeObject(value),
  };
}

function normalizeOneToolConfig(value: unknown): Record<string, unknown> {
  if (typeof value === "boolean") {
    return { enabled: value };
  }
  if (!isRecord(value)) {
    return {};
  }
  return { ...value };
}

function defaultToolConfigFromManifest(manifest: AdapterManifest): Record<string, Record<string, unknown>> {
  const seeded: Record<string, Record<string, unknown>> = {};

  for (const skill of manifest.toolSkills ?? []) {
    seeded[skill.id] = {
      enabled: skill.enabledByDefault ?? true,
      ...(skill.defaultConfig ?? {}),
    };
  }

  for (const [skillId, config] of Object.entries(manifest.defaultToolConfig ?? {})) {
    const current = seeded[skillId] ?? { enabled: true };
    seeded[skillId] = {
      ...current,
      ...normalizeOneToolConfig(config),
    };
  }

  return seeded;
}

function normalizeToolConfig(
  manifest: AdapterManifest,
  value: unknown,
): Record<string, Record<string, unknown>> {
  const defaults = defaultToolConfigFromManifest(manifest);
  const incoming = safeObject(value);
  const normalized: Record<string, Record<string, unknown>> = {};

  const allSkillIds = new Set<string>([
    ...Object.keys(defaults),
    ...Object.keys(incoming),
  ]);

  for (const skillId of allSkillIds) {
    normalized[skillId] = {
      ...(defaults[skillId] ?? { enabled: true }),
      ...normalizeOneToolConfig(incoming[skillId]),
    };
  }

  return normalized;
}

function validateToolConfig(
  toolConfig: Record<string, Record<string, unknown>>,
): string[] {
  const errors: string[] = [];

  for (const [skillId, config] of Object.entries(toolConfig)) {
    if (!isRecord(config)) {
      errors.push(`Tool config for ${skillId} must be an object`);
      continue;
    }
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
      errors.push(`Tool config '${skillId}.enabled' must be boolean`);
    }
  }

  return errors;
}

function validateConfig(config: Record<string, unknown>, schema: AdapterConfigField[]): string[] {
  const errors: string[] = [];

  for (const field of schema) {
    const value = config[field.key];
    const isEmpty = value === undefined || value === null || value === "";

    if (isEmpty) {
      if (field.required) {
        errors.push(`${field.label || field.key} is required`);
      }
      continue;
    }

    switch (field.type) {
      case "string": {
        if (typeof value !== "string") {
          errors.push(`${field.label || field.key} must be a string`);
          break;
        }
        if (typeof field.min === "number" && value.length < field.min) {
          errors.push(`${field.label || field.key} must be at least ${field.min} characters`);
        }
        if (typeof field.max === "number" && value.length > field.max) {
          errors.push(`${field.label || field.key} must be at most ${field.max} characters`);
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || Number.isNaN(value)) {
          errors.push(`${field.label || field.key} must be a number`);
          break;
        }
        if (typeof field.min === "number" && value < field.min) {
          errors.push(`${field.label || field.key} must be >= ${field.min}`);
        }
        if (typeof field.max === "number" && value > field.max) {
          errors.push(`${field.label || field.key} must be <= ${field.max}`);
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push(`${field.label || field.key} must be true or false`);
        }
        break;
      }
      case "select": {
        if (!field.options || field.options.length === 0) {
          break;
        }
        const valid = field.options.some((option) => option.value === value);
        if (!valid) {
          errors.push(`${field.label || field.key} has an invalid selection`);
        }
        break;
      }
      case "json": {
        if (value === undefined) {
          errors.push(`${field.label || field.key} must contain valid JSON`);
        }
        break;
      }
      default:
        break;
    }
  }

  return errors;
}

const LEGACY_BUILTIN_ID_ALIASES: Record<string, string> = {
  "steward.http-surface": "steward.starter.http-surface",
  "steward.docker-ops": "steward.starter.docker-ops",
  "steward.snmp-network-intel": "steward.starter.snmp-network-intel",
  "steward.linux-server": "steward.starter.linux-server",
  "steward.windows-server": "steward.starter.windows-server",
  "steward.ubiquiti-unifi": "steward.starter.ubiquiti-unifi",
};

function shouldRefreshBuiltinFiles(
  manifestPath: string,
  normalizedManifest: AdapterManifest,
  entryPath: string,
  entrySource: string,
): boolean {
  if (!existsSync(manifestPath) || !existsSync(entryPath)) {
    return true;
  }

  try {
    const existingManifest = readManifest(path.dirname(manifestPath));
    const existingEntry = readFileSync(entryPath, "utf-8");
    return JSON.stringify(existingManifest) !== JSON.stringify(normalizedManifest)
      || existingEntry !== entrySource.trimStart();
  } catch {
    return true;
  }
}

function ensureBuiltinAdaptersInstalled(): void {
  const dir = adaptersDir();

  for (const builtin of BUILTIN_ADAPTERS) {
    const normalizedManifest: AdapterManifest = {
      ...builtin.manifest,
      skillMdPath: sanitizeMarkdownPath(builtin.manifest.skillMdPath) ?? DEFAULT_ADAPTER_SKILL_MD_PATH,
      toolSkills: normalizeManifestToolSkills(builtin.manifest),
    };

    const targetDir = path.join(dir, builtin.dirName);
    const manifestPath = path.join(targetDir, "manifest.json");
    const entryPath = path.join(targetDir, normalizedManifest.entry ?? "index.js");
    const refreshBuiltin = shouldRefreshBuiltinFiles(
      manifestPath,
      normalizedManifest,
      entryPath,
      builtin.entrySource,
    );

    mkdirSync(targetDir, { recursive: true });

    if (refreshBuiltin) {
      writeFileSync(manifestPath, `${JSON.stringify(normalizedManifest, null, 2)}\n`, "utf-8");
    }
    if (refreshBuiltin) {
      writeFileSync(entryPath, builtin.entrySource.trimStart(), "utf-8");
    }

    const adapterSkillMdPath = path.join(
      targetDir,
      normalizedManifest.skillMdPath ?? DEFAULT_ADAPTER_SKILL_MD_PATH,
    );
    mkdirSync(path.dirname(adapterSkillMdPath), { recursive: true });
    if (refreshBuiltin || !existsSync(adapterSkillMdPath)) {
      writeFileSync(adapterSkillMdPath, buildAdapterSkillMarkdown(normalizedManifest), "utf-8");
    }

    for (const skill of normalizedManifest.toolSkills ?? []) {
      const relativeSkillPath = skill.skillMdPath ?? defaultToolSkillMarkdownPath(skill.id);
      const absoluteSkillPath = path.join(targetDir, relativeSkillPath);
      mkdirSync(path.dirname(absoluteSkillPath), { recursive: true });
      if (refreshBuiltin || !existsSync(absoluteSkillPath)) {
        writeFileSync(absoluteSkillPath, buildToolSkillMarkdown(skill), "utf-8");
      }
    }
  }
}

function adapterRecordFromRow(row: Record<string, unknown>): AdapterRecord {
  const manifest = buildManifestFromRow(row);
  const source = asAdapterSource(row.source);
  const dirName = String(row.dirName ?? "");
  const location = source === "file" ? adapterPath(dirName) : undefined;
  const adapterSkillMd = safeReadMarkdownAttachment(location, manifest.skillMdPath);

  const hydratedToolSkills = normalizeManifestToolSkills(manifest).map((skill) => {
    const skillPath = sanitizeMarkdownPath(skill.skillMdPath) ?? defaultToolSkillMarkdownPath(skill.id);
    return {
      ...skill,
      skillMdPath: skillPath,
      skillMd: safeReadMarkdownAttachment(location, skillPath),
    };
  });

  return {
    id: String(row.id),
    source,
    dirName,
    name: String(row.name),
    description: String(row.description ?? ""),
    version: String(row.version ?? "0.0.0"),
    author: String(row.author ?? ""),
    docsUrl: row.docsUrl ? String(row.docsUrl) : manifest.docsUrl,
    provides: safeArray<AdapterCapability>(row.provides),
    configSchema: manifest.configSchema ?? safeArray<AdapterConfigField>(row.configSchema),
    config: safeObject(row.config),
    skillMdPath: manifest.skillMdPath,
    skillMd: adapterSkillMd,
    toolSkills: hydratedToolSkills,
    toolConfig: normalizeToolConfig(manifest, row.toolConfig),
    manifest: {
      ...manifest,
      toolSkills: hydratedToolSkills.map((skill) => {
        const rest = { ...skill };
        delete rest.skillMd;
        return rest;
      }),
    },
    enabled: row.enabled === 1,
    status: String(row.status) as AdapterRecord["status"],
    error: row.error ? String(row.error) : undefined,
    installedAt: String(row.installedAt),
    updatedAt: String(row.updatedAt),
    location,
  };
}

interface LoadedAdapterEntry {
  source: AdapterSource;
  dirName: string;
  manifest: AdapterManifest;
  adapter: StewardAdapter;
  config: Record<string, unknown>;
  toolConfig: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Adapter Registry
// ---------------------------------------------------------------------------

class AdapterRegistry {
  private loaded = new Map<string, LoadedAdapterEntry>();
  private playbookCache: PlaybookDefinition[] = [];
  private initialized = false;

  private runtimeContext(id: string, entry: LoadedAdapterEntry): AdapterRuntimeContext {
    return {
      adapterId: id,
      source: entry.source,
      manifest: entry.manifest,
      config: { ...entry.config },
      toolConfig: { ...entry.toolConfig },
      getConfig: () => ({ ...entry.config }),
      getToolConfig: (skillId?: string) => {
        if (skillId) {
          return { ...(entry.toolConfig[skillId] ?? {}) };
        }
        return { ...entry.toolConfig };
      },
      isToolEnabled: (skillId: string) => {
        const value = entry.toolConfig[skillId];
        if (!value || typeof value.enabled !== "boolean") {
          return true;
        }
        return value.enabled;
      },
      log: (level, message, details) => {
        const prefix = `[adapter:${id}] ${message}`;
        if (level === "error") {
          console.error(prefix, details ?? "");
          return;
        }
        if (level === "warn") {
          console.warn(prefix, details ?? "");
          return;
        }
        if (level === "info") {
          console.info(prefix, details ?? "");
          return;
        }
        console.debug(prefix, details ?? "");
      },
    };
  }

  /** Scan disk, reconcile with DB, and load enabled adapters. */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    ensureBuiltinAdaptersInstalled();

    const dir = adaptersDir();
    const db = getDb();

    // Scan disk for adapter directories.
    const diskAdapters = new Map<string, { dirName: string; manifest: AdapterManifest }>();
    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const currentAdapterPath = path.join(dir, entry.name);
        try {
          const manifest = readManifest(currentAdapterPath);
          diskAdapters.set(manifest.id, { dirName: entry.name, manifest });
        } catch (err) {
          console.warn(`[adapters] Skipping ${entry.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Reconcile: add/update discovered file adapters and remove stale file adapters.
    const now = new Date().toISOString();
    const existingRows = db.prepare("SELECT * FROM adapters").all() as Record<string, unknown>[];
    const existingById = new Map(existingRows.map((row) => [String(row.id), row]));

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO adapters (
        id, source, dirName, name, description, version, author, docsUrl,
        provides, manifestJson, configSchema, config, toolSkills, toolConfig,
        enabled, status, installedAt, updatedAt
      )
      VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [id, { dirName, manifest }] of diskAdapters) {
      const existing = existingById.get(id);
      const legacyId = LEGACY_BUILTIN_ID_ALIASES[id];
      const legacyRow = !existing && legacyId ? existingById.get(legacyId) : undefined;
      const seedRow = existing ?? legacyRow;
      const mergedConfig = normalizeConfig(manifest, seedRow?.config);
      const mergedToolConfig = normalizeToolConfig(manifest, seedRow?.toolConfig);

      const payload = {
        dirName,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        author: manifest.author,
        docsUrl: manifest.docsUrl ?? null,
        provides: JSON.stringify(manifest.provides ?? []),
        manifestJson: JSON.stringify(manifest),
        configSchema: JSON.stringify(manifest.configSchema ?? []),
        config: JSON.stringify(mergedConfig),
        toolSkills: JSON.stringify(manifest.toolSkills ?? []),
        toolConfig: JSON.stringify(mergedToolConfig),
        enabled: seedRow?.enabled === 0 ? 0 : 1,
        status: typeof seedRow?.status === "string" ? String(seedRow.status) : "disabled",
        installedAt: seedRow?.installedAt ? String(seedRow.installedAt) : now,
      };

      if (!existing) {
        insertStmt.run(
          id,
          payload.dirName,
          payload.name,
          payload.description,
          payload.version,
          payload.author,
          payload.docsUrl,
          payload.provides,
          payload.manifestJson,
          payload.configSchema,
          payload.config,
          payload.toolSkills,
          payload.toolConfig,
          payload.enabled,
          payload.status,
          payload.installedAt,
          now,
        );
      } else {
        db.prepare(`
          UPDATE adapters
          SET source = 'file',
              dirName = ?,
              name = ?,
              description = ?,
              version = ?,
              author = ?,
              docsUrl = ?,
              provides = ?,
              manifestJson = ?,
              configSchema = ?,
              config = ?,
              toolSkills = ?,
              toolConfig = ?,
              updatedAt = ?
          WHERE id = ?
        `).run(
          payload.dirName,
          payload.name,
          payload.description,
          payload.version,
          payload.author,
          payload.docsUrl,
          payload.provides,
          payload.manifestJson,
          payload.configSchema,
          payload.config,
          payload.toolSkills,
          payload.toolConfig,
          now,
          id,
        );
      }
    }

    for (const row of existingRows) {
      const id = String(row.id);
      const source = asAdapterSource(row.source);
      if (source === "file" && !diskAdapters.has(id)) {
        db.prepare("DELETE FROM adapters WHERE id = ?").run(id);
      }
    }

    const enabledRows = db.prepare("SELECT * FROM adapters WHERE enabled = 1").all() as Record<string, unknown>[];
    for (const row of enabledRows) {
      const id = String(row.id);
      const source = asAdapterSource(row.source);
      if (source !== "file") {
        continue;
      }

      const diskEntry = diskAdapters.get(id);
      if (!diskEntry) {
        db.prepare("UPDATE adapters SET status = 'error', error = ?, updatedAt = ? WHERE id = ?")
          .run("Adapter files are missing from disk", now, id);
        continue;
      }

      await this.loadAdapter(
        id,
        source,
        diskEntry.dirName,
        diskEntry.manifest,
        safeObject(row.config),
        safeObject(row.toolConfig),
      );
    }

    this.rebuildPlaybookCache();
  }

  /** Force re-scan and reload. */
  async reload(): Promise<void> {
    for (const [id, entry] of this.loaded) {
      try {
        await entry.adapter.deactivate?.(this.runtimeContext(id, entry));
      } catch (err) {
        console.warn(`[adapters] Error deactivating ${id}:`, err);
      }
    }

    this.loaded.clear();
    this.playbookCache = [];
    this.initialized = false;

    await this.initialize();
  }

  private async loadAdapter(
    id: string,
    source: AdapterSource,
    dirName: string,
    manifest: AdapterManifest,
    configValue: unknown,
    toolConfigValue: unknown,
  ): Promise<void> {
    const currentAdapterPath = path.join(adaptersDir(), dirName);
    const db = getDb();
    const now = new Date().toISOString();

    try {
      const adapter = await loadAdapterModule(currentAdapterPath, manifest);
      const entry: LoadedAdapterEntry = {
        source,
        dirName,
        manifest,
        adapter,
        config: normalizeConfig(manifest, configValue),
        toolConfig: normalizeToolConfig(manifest, toolConfigValue),
      };

      await adapter.activate?.(this.runtimeContext(id, entry));
      this.loaded.set(id, entry);
      db.prepare("UPDATE adapters SET status = 'loaded', error = NULL, updatedAt = ? WHERE id = ?").run(now, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[adapters] Failed to load ${id}: ${message}`);
      db.prepare("UPDATE adapters SET status = 'error', error = ?, updatedAt = ? WHERE id = ?").run(message, now, id);
    }
  }

  private rebuildPlaybookCache(): void {
    const playbooks: PlaybookDefinition[] = [];
    for (const [id, entry] of this.loaded) {
      if (!entry.adapter.playbooks) {
        continue;
      }

      try {
        playbooks.push(...entry.adapter.playbooks(this.runtimeContext(id, entry)));
      } catch (err) {
        console.warn("[adapters] Error collecting playbooks:", err);
      }
    }
    this.playbookCache = playbooks;
  }

  private resolveFileManifestForRow(row: Record<string, unknown>): AdapterManifest {
    const dirName = String(row.dirName ?? "");
    const onDiskPath = adapterPath(dirName);
    if (dirName && existsSync(path.join(onDiskPath, "manifest.json"))) {
      try {
        return readManifest(onDiskPath);
      } catch {
        // fall back to persisted snapshot
      }
    }
    return buildManifestFromRow(row);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getAdapterRecords(): AdapterRecord[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM adapters ORDER BY name").all() as Record<string, unknown>[];
    return rows.map(adapterRecordFromRow);
  }

  getAdapterRecordById(id: string): AdapterRecord | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? adapterRecordFromRow(row) : undefined;
  }

  getAdapterPackageById(id: string): AdapterPackageRecord | undefined {
    const db = getDb();
    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }

    const record = adapterRecordFromRow(row);
    const location = record.location;
    if (!location) {
      throw new Error("Only file-backed adapters can be edited");
    }

    const manifest = parseManifestMutation(record.manifest);
    const entryRelative = manifest.entry ?? "index.js";
    const entryPath = resolveSafeChildPath(location, entryRelative);
    const entrySource = readFileIfExists(entryPath) ?? "";

    const adapterSkillPath = manifest.skillMdPath ?? DEFAULT_ADAPTER_SKILL_MD_PATH;
    const adapterSkillMd = readFileIfExists(resolveSafeChildPath(location, adapterSkillPath));

    const toolSkillMd: Record<string, string> = {};
    for (const skill of manifest.toolSkills ?? []) {
      const skillMdPath = sanitizeMarkdownPath(skill.skillMdPath) ?? defaultToolSkillMarkdownPath(skill.id);
      const skillMd = readFileIfExists(resolveSafeChildPath(location, skillMdPath));
      if (typeof skillMd === "string") {
        toolSkillMd[skill.id] = skillMd;
      }
    }

    return {
      adapter: record,
      manifest,
      entrySource,
      adapterSkillMd,
      toolSkillMd,
      isBuiltin: BUILTIN_ADAPTER_IDS.has(record.id),
    };
  }

  async createAdapterPackage(
    mutation: AdapterPackageMutation,
    options?: AdapterMutationOptions,
  ): Promise<AdapterRecord> {
    const manifest = parseManifestMutation(mutation.manifest);
    if (!manifest.id) {
      throw new Error("Adapter manifest id is required");
    }

    await this.initialize();
    const existing = this.getAdapterRecordById(manifest.id);
    if (existing) {
      throw new Error(`Adapter already exists: ${manifest.id}`);
    }

    const db = getDb();
    const existingRows = db.prepare("SELECT dirName FROM adapters").all() as Array<{ dirName: string }>;
    const usedDirs = new Set(existingRows.map((row) => String(row.dirName)));

    const baseDirName = `custom-${slugify(manifest.id)}`;
    let dirName = baseDirName;
    let suffix = 1;
    while (usedDirs.has(dirName) || existsSync(adapterPath(dirName))) {
      dirName = `${baseDirName}-${suffix}`;
      suffix += 1;
    }

    const targetDir = adapterPath(dirName);
    writeAdapterPackageFiles(targetDir, {
      ...mutation,
      manifest,
    });

    await this.reload();
    const created = this.getAdapterRecordById(manifest.id);
    if (!created) {
      throw new Error(`Adapter was created on disk but not loaded: ${manifest.id}`);
    }

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Created adapter: ${created.name}`,
      context: { adapterId: created.id },
    });

    return created;
  }

  async updateAdapterPackage(
    id: string,
    mutation: AdapterPackageMutation,
    options?: AdapterMutationOptions,
  ): Promise<AdapterRecord> {
    const db = getDb();
    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Adapter not found: ${id}`);
    }

    const record = adapterRecordFromRow(row);
    if (!record.location) {
      throw new Error("Only file-backed adapters can be edited");
    }

    const manifest = parseManifestMutation(mutation.manifest);
    if (manifest.id !== id) {
      throw new Error("Adapter id cannot be changed");
    }

    writeAdapterPackageFiles(record.location, {
      ...mutation,
      manifest,
    });

    await this.reload();
    const updated = this.getAdapterRecordById(id);
    if (!updated) {
      throw new Error(`Adapter update applied but adapter missing: ${id}`);
    }

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Updated adapter package: ${updated.name}`,
      context: { adapterId: updated.id },
    });

    return updated;
  }

  async deleteAdapterPackage(id: string, options?: AdapterMutationOptions): Promise<void> {
    if (BUILTIN_ADAPTER_IDS.has(id)) {
      throw new Error("Built-in adapters cannot be deleted");
    }

    const db = getDb();
    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Adapter not found: ${id}`);
    }
    const record = adapterRecordFromRow(row);
    if (!record.location) {
      throw new Error("Only file-backed adapters can be deleted");
    }

    if (existsSync(record.location)) {
      rmSync(record.location, { recursive: true, force: true });
    }

    await this.reload();

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Deleted adapter package: ${record.name}`,
      context: { adapterId: id },
    });
  }

  async enableAdapter(id: string, options?: AdapterMutationOptions): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare("UPDATE adapters SET enabled = 1, updatedAt = ? WHERE id = ?").run(now, id);

    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Adapter not found: ${id}`);
    }

    const source = asAdapterSource(row.source);
    if (source !== "file") {
      throw new Error(`Unsupported adapter source: ${source}`);
    }

    const dirName = String(row.dirName);
    const manifest = this.resolveFileManifestForRow(row);

    if (this.loaded.has(id)) {
      const existing = this.loaded.get(id);
      if (existing) {
        try {
          await existing.adapter.deactivate?.(this.runtimeContext(id, existing));
        } catch (err) {
          console.warn(`[adapters] Error deactivating ${id}:`, err);
        }
      }
      this.loaded.delete(id);
    }

    await this.loadAdapter(id, source, dirName, manifest, row.config, row.toolConfig);
    this.rebuildPlaybookCache();

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Enabled adapter: ${manifest.name}`,
      context: { adapterId: id },
    });
  }

  async disableAdapter(id: string, options?: AdapterMutationOptions): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();

    const entry = this.loaded.get(id);
    if (entry) {
      try {
        await entry.adapter.deactivate?.(this.runtimeContext(id, entry));
      } catch (err) {
        console.warn(`[adapters] Error deactivating ${id}:`, err);
      }
      this.loaded.delete(id);
      this.rebuildPlaybookCache();
    }

    db.prepare("UPDATE adapters SET enabled = 0, status = 'disabled', error = NULL, updatedAt = ? WHERE id = ?").run(now, id);

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Disabled adapter: ${entry?.manifest.name ?? id}`,
      context: { adapterId: id },
    });
  }

  async updateAdapterConfig(
    id: string,
    payload: {
      config?: Record<string, unknown>;
      mode?: "merge" | "replace";
      toolConfig?: Record<string, unknown>;
      toolMode?: "merge" | "replace";
    },
    options?: AdapterMutationOptions,
  ): Promise<AdapterRecord> {
    const db = getDb();
    const row = db.prepare("SELECT * FROM adapters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Adapter not found: ${id}`);
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Adapter update payload must be an object");
    }

    const manifest = this.resolveFileManifestForRow(row);
    const currentConfig = normalizeConfig(manifest, row.config);
    const currentToolConfig = normalizeToolConfig(manifest, row.toolConfig);

    const configUpdateProvided = payload.config !== undefined;
    const toolUpdateProvided = payload.toolConfig !== undefined;

    if (!configUpdateProvided && !toolUpdateProvided) {
      throw new Error("Nothing to update: provide config and/or toolConfig");
    }

    let nextConfig = currentConfig;
    if (configUpdateProvided) {
      if (!isRecord(payload.config)) {
        throw new Error("Adapter config must be an object");
      }
      const schema = manifest.configSchema ?? safeArray<AdapterConfigField>(row.configSchema);
      const mode = payload.mode ?? "merge";
      const baseConfig = mode === "replace"
        ? defaultsFromManifest(manifest)
        : normalizeConfig(manifest, currentConfig);
      nextConfig = {
        ...baseConfig,
        ...payload.config,
      };

      const validationErrors = validateConfig(nextConfig, schema);
      if (validationErrors.length > 0) {
        throw new Error(`Invalid adapter config: ${validationErrors.join("; ")}`);
      }
    }

    let nextToolConfig = currentToolConfig;
    if (toolUpdateProvided) {
      if (!isRecord(payload.toolConfig)) {
        throw new Error("Adapter toolConfig must be an object");
      }

      const toolMode = payload.toolMode ?? "merge";
      const incomingPatch = payload.toolConfig;
      const baseToolConfig = toolMode === "replace"
        ? defaultToolConfigFromManifest(manifest)
        : normalizeToolConfig(manifest, currentToolConfig);
      const mergedToolConfig: Record<string, Record<string, unknown>> = {
        ...baseToolConfig,
      };

      for (const [skillId, value] of Object.entries(incomingPatch)) {
        mergedToolConfig[skillId] = {
          ...(baseToolConfig[skillId] ?? { enabled: true }),
          ...normalizeOneToolConfig(value),
        };
      }

      const toolValidationErrors = validateToolConfig(mergedToolConfig);
      if (toolValidationErrors.length > 0) {
        throw new Error(`Invalid adapter toolConfig: ${toolValidationErrors.join("; ")}`);
      }

      nextToolConfig = mergedToolConfig;
    }

    const now = new Date().toISOString();
    db.prepare("UPDATE adapters SET config = ?, toolConfig = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(nextConfig), JSON.stringify(nextToolConfig), now, id);

    const loadedEntry = this.loaded.get(id);
    if (loadedEntry) {
      loadedEntry.config = normalizeConfig(loadedEntry.manifest, nextConfig);
      loadedEntry.toolConfig = normalizeToolConfig(loadedEntry.manifest, nextToolConfig);

      if (loadedEntry.adapter.onConfigChange) {
        try {
          await loadedEntry.adapter.onConfigChange(
            loadedEntry.config,
            loadedEntry.toolConfig,
            this.runtimeContext(id, loadedEntry),
          );
          db.prepare("UPDATE adapters SET status = 'loaded', error = NULL, updatedAt = ? WHERE id = ?").run(now, id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          db.prepare("UPDATE adapters SET status = 'error', error = ?, updatedAt = ? WHERE id = ?").run(message, now, id);
          throw new Error(`Adapter reconfiguration failed: ${message}`);
        }
      }

      this.rebuildPlaybookCache();
    }

    await stateStore.addAction({
      actor: normalizeMutationActor(options?.actor),
      kind: "config",
      message: `Updated adapter configuration: ${manifest.name}`,
      context: {
        adapterId: id,
        mode: payload.mode ?? "merge",
        toolMode: payload.toolMode ?? "merge",
        configKeys: payload.config ? Object.keys(payload.config) : [],
        toolKeys: payload.toolConfig ? Object.keys(payload.toolConfig) : [],
      },
    });

    const updated = this.getAdapterRecordById(id);
    if (!updated) {
      throw new Error("Adapter config persisted but could not be reloaded");
    }
    return updated;
  }

  /** Aggregate: all playbooks from loaded adapters. */
  getAdapterPlaybooks(): PlaybookDefinition[] {
    return this.playbookCache;
  }

  /** Aggregate: run all adapter discover() functions in parallel. */
  async runAdapterDiscovery(knownIps: string[]): Promise<DiscoveryCandidate[]> {
    const promises: Promise<DiscoveryCandidate[]>[] = [];

    for (const [id, entry] of this.loaded) {
      if (!entry.adapter.discover) {
        continue;
      }

      promises.push(
        Promise.resolve()
          .then(() => entry.adapter.discover?.(knownIps, this.runtimeContext(id, entry)))
          .then((candidates) => {
            if (!Array.isArray(candidates)) {
              if (candidates != null) {
                console.warn(
                  `[adapters] Discovery for ${id} returned a non-array value. Ignoring result.`,
                );
              }
              return [];
            }
            return candidates;
          })
          .catch((err) => {
            console.warn(`[adapters] Discovery error in ${id}:`, err);
            return [];
          }),
      );
    }

    const results = await Promise.all(promises);
    return results.flat();
  }

  /** Aggregate: enrich a candidate through all loaded enrichment adapters. */
  async enrichCandidate(candidate: DiscoveryCandidate): Promise<DiscoveryCandidate> {
    let result = candidate;
    for (const [id, entry] of this.loaded) {
      if (!entry.adapter.enrich) {
        continue;
      }

      try {
        result = await entry.adapter.enrich(result, this.runtimeContext(id, entry));
      } catch (err) {
        console.warn(`[adapters] Enrichment error in ${id}:`, err);
      }
    }

    return result;
  }

  /** Aggregate: deterministic device profile matches from loaded profile adapters. */
  async getDeviceProfileMatches(device: Device): Promise<AdapterProfileMatch[]> {
    const matches: AdapterProfileMatch[] = [];

    for (const [id, entry] of this.loaded) {
      if (!entry.adapter.match) {
        continue;
      }

      try {
        const result = await entry.adapter.match(device, this.runtimeContext(id, entry));
        const normalized = Array.isArray(result)
          ? result
          : result
            ? [result]
            : [];

        for (const match of normalized) {
          if (!match || typeof match !== "object") {
            continue;
          }
          matches.push({
            ...match,
            adapterId: match.adapterId ?? id,
            name: match.name ?? entry.manifest.name,
            kind: match.kind ?? "primary",
          });
        }
      } catch (err) {
        console.warn(`[adapters] Profile match error in ${id}:`, err);
      }
    }

    matches.sort((left, right) => {
      if ((left.kind ?? "primary") !== (right.kind ?? "primary")) {
        const rank = (value: string) => (value === "primary" ? 0 : value === "fallback" ? 1 : 2);
        return rank(left.kind ?? "primary") - rank(right.kind ?? "primary");
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    });

    return matches;
  }

  /** Aggregate: extra capabilities from all loaded protocol adapters. */
  getAdapterCapabilities(device: Device): ManagementCapability[] {
    const capabilities: ManagementCapability[] = [];

    for (const [id, entry] of this.loaded) {
      if (!entry.adapter.capabilities) {
        continue;
      }

      try {
        capabilities.push(...entry.adapter.capabilities(device, this.runtimeContext(id, entry)));
      } catch (err) {
        console.warn(`[adapters] Capability error in ${id}:`, err);
      }
    }

    return capabilities;
  }

  async getDeviceWebFlows(device: Device): Promise<DeviceWebFlowBinding[]> {
    const matches = await this.getDeviceProfileMatches(device);
    const matchByAdapterId = new Map<string, AdapterProfileMatch>();
    for (const match of matches) {
      if (match.adapterId && !matchByAdapterId.has(match.adapterId)) {
        matchByAdapterId.set(match.adapterId, match);
      }
    }

    const bindings: DeviceWebFlowBinding[] = [];
    for (const [id, entry] of this.loaded) {
      const flows = Array.isArray(entry.manifest.webFlows) ? entry.manifest.webFlows : [];
      if (flows.length === 0) {
        continue;
      }
      const profileMatch = matchByAdapterId.get(id);
      const likelyHttpSurface = device.services.some((service) => {
        const name = String(service.name ?? "").toLowerCase();
        return [80, 443, 8080, 8443, 5000, 5001, 7443, 9000, 9443].includes(Number(service.port))
          || name.includes("http")
          || name.includes("https")
          || name.includes("web");
      });
      if (!profileMatch && !likelyHttpSurface) {
        continue;
      }
      for (const flow of flows) {
        bindings.push({
          adapterId: id,
          adapterName: entry.manifest.name,
          profileMatch,
          flow,
        });
      }
    }

    bindings.sort((left, right) => {
      const leftKind = left.profileMatch?.kind ?? "supporting";
      const rightKind = right.profileMatch?.kind ?? "supporting";
      const kindRank = (value: string) => value === "primary" ? 0 : value === "fallback" ? 1 : 2;
      if (kindRank(leftKind) !== kindRank(rightKind)) {
        return kindRank(leftKind) - kindRank(rightKind);
      }
      const leftConfidence = left.profileMatch?.confidence ?? (left.adapterId === "steward.http-surface" ? 0.35 : 0);
      const rightConfidence = right.profileMatch?.confidence ?? (right.adapterId === "steward.http-surface" ? 0.35 : 0);
      if (leftConfidence !== rightConfidence) {
        return rightConfidence - leftConfidence;
      }
      return left.flow.name.localeCompare(right.flow.name);
    });

    return bindings;
  }
}

export const adapterRegistry = new AdapterRegistry();
