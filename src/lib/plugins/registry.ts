import { readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getDataDir, getDb } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import { readManifest, loadPluginModule } from "@/lib/plugins/loader";
import type {
  PluginManifest,
  PluginRecord,
  PluginCapability,
  StewardPlugin,
} from "@/lib/plugins/types";
import type { DiscoveryCandidate } from "@/lib/discovery/types";
import type { Device, PlaybookDefinition } from "@/lib/state/types";
import type { ManagementCapability } from "@/lib/protocols/negotiator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluginsDir(): string {
  const dir = process.env.STEWARD_PLUGINS_DIR ?? path.join(getDataDir(), "plugins");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pluginRecordFromRow(row: Record<string, unknown>): PluginRecord {
  return {
    id: String(row.id),
    dirName: String(row.dirName),
    name: String(row.name),
    description: String(row.description ?? ""),
    version: String(row.version ?? "0.0.0"),
    author: String(row.author ?? ""),
    provides: JSON.parse(String(row.provides ?? "[]")) as PluginCapability[],
    enabled: row.enabled === 1,
    status: String(row.status) as PluginRecord["status"],
    error: row.error ? String(row.error) : undefined,
    installedAt: String(row.installedAt),
    updatedAt: String(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Plugin Registry
// ---------------------------------------------------------------------------

class PluginRegistry {
  private loaded = new Map<string, { manifest: PluginManifest; plugin: StewardPlugin }>();
  private playbookCache: PlaybookDefinition[] = [];
  private initialized = false;

  /** Scan disk, reconcile with DB, load enabled plugins */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const dir = pluginsDir();
    const db = getDb();

    // Scan disk for plugin directories
    const diskPlugins = new Map<string, { dirName: string; manifest: PluginManifest }>();
    if (existsSync(dir)) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path.join(dir, entry.name);
        try {
          const manifest = readManifest(pluginPath);
          diskPlugins.set(manifest.id, { dirName: entry.name, manifest });
        } catch (err) {
          console.warn(`[plugins] Skipping ${entry.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Reconcile: add new plugins, remove deleted ones
    const now = new Date().toISOString();
    const existingRows = db.prepare("SELECT * FROM plugins").all() as Record<string, unknown>[];
    const existingIds = new Set(existingRows.map((r) => String(r.id)));

    // Insert new plugins found on disk
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO plugins (id, dirName, name, description, version, author, provides, enabled, status, installedAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'disabled', ?, ?)
    `);

    for (const [id, { dirName, manifest }] of diskPlugins) {
      if (!existingIds.has(id)) {
        insertStmt.run(
          id, dirName, manifest.name, manifest.description,
          manifest.version, manifest.author, JSON.stringify(manifest.provides),
          now, now,
        );
      } else {
        // Update manifest info in case it changed
        db.prepare(`
          UPDATE plugins SET name = ?, description = ?, version = ?, author = ?, provides = ?, dirName = ?, updatedAt = ?
          WHERE id = ?
        `).run(manifest.name, manifest.description, manifest.version, manifest.author, JSON.stringify(manifest.provides), dirName, now, id);
      }
    }

    // Remove records for plugins no longer on disk
    for (const row of existingRows) {
      const id = String(row.id);
      if (!diskPlugins.has(id)) {
        db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
      }
    }

    // Load all enabled plugins
    const enabledRows = db.prepare("SELECT * FROM plugins WHERE enabled = 1").all() as Record<string, unknown>[];
    for (const row of enabledRows) {
      const id = String(row.id);
      const diskEntry = diskPlugins.get(id);
      if (!diskEntry) continue;

      await this.loadPlugin(id, diskEntry.dirName, diskEntry.manifest);
    }

    this.rebuildPlaybookCache();
  }

  /** Force re-scan and reload */
  async reload(): Promise<void> {
    // Deactivate all loaded plugins
    for (const [id, { plugin }] of this.loaded) {
      try {
        await plugin.deactivate?.();
      } catch (err) {
        console.warn(`[plugins] Error deactivating ${id}:`, err);
      }
    }
    this.loaded.clear();
    this.playbookCache = [];
    this.initialized = false;
    await this.initialize();
  }

  private async loadPlugin(id: string, dirName: string, manifest: PluginManifest): Promise<void> {
    const dir = pluginsDir();
    const pluginPath = path.join(dir, dirName);
    const db = getDb();
    const now = new Date().toISOString();

    try {
      const plugin = await loadPluginModule(pluginPath, manifest);
      await plugin.activate?.();
      this.loaded.set(id, { manifest, plugin });
      db.prepare("UPDATE plugins SET status = 'loaded', error = NULL, updatedAt = ? WHERE id = ?").run(now, id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] Failed to load ${id}: ${message}`);
      db.prepare("UPDATE plugins SET status = 'error', error = ?, updatedAt = ? WHERE id = ?").run(message, now, id);
    }
  }

  private rebuildPlaybookCache(): void {
    const playbooks: PlaybookDefinition[] = [];
    for (const [, { plugin }] of this.loaded) {
      if (plugin.playbooks) {
        try {
          playbooks.push(...plugin.playbooks());
        } catch (err) {
          console.warn("[plugins] Error collecting playbooks:", err);
        }
      }
    }
    this.playbookCache = playbooks;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getPluginRecords(): PluginRecord[] {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM plugins ORDER BY name").all() as Record<string, unknown>[];
    return rows.map(pluginRecordFromRow);
  }

  async enablePlugin(id: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare("UPDATE plugins SET enabled = 1, updatedAt = ? WHERE id = ?").run(now, id);

    // Load the plugin
    const row = db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Plugin not found: ${id}`);

    const dirName = String(row.dirName);
    const pluginPath = path.join(pluginsDir(), dirName);
    const manifest = readManifest(pluginPath);
    await this.loadPlugin(id, dirName, manifest);
    this.rebuildPlaybookCache();

    await stateStore.addAction({
      actor: "user",
      kind: "config",
      message: `Enabled plugin: ${manifest.name}`,
      context: { pluginId: id },
    });
  }

  async disablePlugin(id: string): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();

    // Deactivate if loaded
    const entry = this.loaded.get(id);
    if (entry) {
      try {
        await entry.plugin.deactivate?.();
      } catch (err) {
        console.warn(`[plugins] Error deactivating ${id}:`, err);
      }
      this.loaded.delete(id);
      this.rebuildPlaybookCache();
    }

    db.prepare("UPDATE plugins SET enabled = 0, status = 'disabled', error = NULL, updatedAt = ? WHERE id = ?").run(now, id);

    await stateStore.addAction({
      actor: "user",
      kind: "config",
      message: `Disabled plugin: ${entry?.manifest.name ?? id}`,
      context: { pluginId: id },
    });
  }

  /** Aggregate: all playbooks from loaded plugins */
  getPluginPlaybooks(): PlaybookDefinition[] {
    return this.playbookCache;
  }

  /** Aggregate: run all plugin discover() functions in parallel */
  async runPluginDiscovery(knownIps: string[]): Promise<DiscoveryCandidate[]> {
    const promises: Promise<DiscoveryCandidate[]>[] = [];

    for (const [id, { plugin }] of this.loaded) {
      if (plugin.discover) {
        promises.push(
          plugin.discover(knownIps).catch((err) => {
            console.warn(`[plugins] Discovery error in ${id}:`, err);
            return [];
          }),
        );
      }
    }

    const results = await Promise.all(promises);
    return results.flat();
  }

  /** Aggregate: enrich a candidate through all loaded enrichment plugins */
  async enrichCandidate(candidate: DiscoveryCandidate): Promise<DiscoveryCandidate> {
    let result = candidate;
    for (const [id, { plugin }] of this.loaded) {
      if (plugin.enrich) {
        try {
          result = await plugin.enrich(result);
        } catch (err) {
          console.warn(`[plugins] Enrichment error in ${id}:`, err);
        }
      }
    }
    return result;
  }

  /** Aggregate: extra capabilities from all loaded protocol plugins */
  getPluginCapabilities(device: Device): ManagementCapability[] {
    const caps: ManagementCapability[] = [];
    for (const [id, { plugin }] of this.loaded) {
      if (plugin.capabilities) {
        try {
          caps.push(...plugin.capabilities(device));
        } catch (err) {
          console.warn(`[plugins] Capability error in ${id}:`, err);
        }
      }
    }
    return caps;
  }
}

export const pluginRegistry = new PluginRegistry();
