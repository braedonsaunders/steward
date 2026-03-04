import { getDb } from "@/lib/state/db";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const SEED_PATH = path.join(__dirname, "oui-seed.json");
const IEEE_OUI_CSV_URL = "https://standards-oui.ieee.org/oui/oui.csv";

let initialized = false;

function normalizeMacPrefix(mac: string): string {
  return mac.toLowerCase().replace(/-/g, ":").slice(0, 8);
}

function ensureSeedData(): void {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM oui_prefixes").get() as { cnt: number }).cnt;
  if (count > 0) {
    initialized = true;
    return;
  }

  if (!existsSync(SEED_PATH)) {
    initialized = true;
    return;
  }

  try {
    const raw = readFileSync(SEED_PATH, "utf-8");
    const seed = JSON.parse(raw) as Record<string, string>;
    const insert = db.prepare("INSERT OR IGNORE INTO oui_prefixes (prefix, vendor) VALUES (?, ?)");
    const tx = db.transaction(() => {
      for (const [prefix, vendor] of Object.entries(seed)) {
        insert.run(normalizeMacPrefix(prefix), vendor);
      }
    });
    tx();
    console.log(`[oui] Seeded ${Object.keys(seed).length} OUI prefixes`);
  } catch (error) {
    console.error("[oui] Failed to load seed data:", error);
  }

  initialized = true;
}

export function lookupOuiVendor(mac: string | undefined): string | undefined {
  if (!mac) return undefined;

  if (!initialized) {
    ensureSeedData();
  }

  const prefix = normalizeMacPrefix(mac);
  const db = getDb();

  try {
    const row = db.prepare("SELECT vendor FROM oui_prefixes WHERE prefix = ?").get(prefix) as { vendor: string } | undefined;
    return row?.vendor;
  } catch {
    return undefined;
  }
}

function parseOuiCsvLine(line: string): { prefix: string; vendor: string } | undefined {
  // CSV format: Registry,Assignment,Organization Name,...
  // Assignment is 6 hex chars like "2C542D"
  const parts = line.split(",");
  if (parts.length < 3) return undefined;

  const assignment = parts[1]?.trim().replace(/"/g, "");
  if (!assignment || assignment.length !== 6 || !/^[0-9A-Fa-f]{6}$/.test(assignment)) {
    return undefined;
  }

  let vendor = parts[2]?.trim().replace(/"/g, "");
  if (!vendor) return undefined;

  // Some vendor names have commas inside quotes, try to reconstruct
  if (vendor.startsWith('"') || (parts.length > 3 && !parts[2]?.trim().endsWith('"'))) {
    vendor = parts.slice(2).join(",").replace(/^"|"$/g, "").trim();
  }

  const prefix = `${assignment.slice(0, 2)}:${assignment.slice(2, 4)}:${assignment.slice(4, 6)}`.toLowerCase();
  return { prefix, vendor };
}

export async function updateOuiDatabase(): Promise<{ updated: number; total: number }> {
  const db = getDb();

  // Check if we've updated recently
  const lastUpdate = db.prepare("SELECT value FROM oui_metadata WHERE key = 'lastUpdatedAt'").get() as { value: string } | undefined;
  if (lastUpdate) {
    const ageMs = Date.now() - new Date(lastUpdate.value).getTime();
    const settings = db.prepare("SELECT value FROM metadata WHERE key = 'runtime.ouiUpdateIntervalMs'").get() as { value: string } | undefined;
    const intervalMs = settings ? Number(settings.value) : 7 * 24 * 60 * 60 * 1000;
    if (ageMs < intervalMs) {
      const count = (db.prepare("SELECT COUNT(*) as cnt FROM oui_prefixes").get() as { cnt: number }).cnt;
      return { updated: 0, total: count };
    }
  }

  try {
    const response = await fetch(IEEE_OUI_CSV_URL, {
      signal: AbortSignal.timeout(30_000),
      headers: { "Accept": "text/csv" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const lines = text.split("\n");
    let updated = 0;

    const insert = db.prepare("INSERT OR REPLACE INTO oui_prefixes (prefix, vendor) VALUES (?, ?)");
    const tx = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const parsed = parseOuiCsvLine(lines[i]);
        if (parsed) {
          insert.run(parsed.prefix, parsed.vendor);
          updated++;
        }
      }
    });
    tx();

    db.prepare("INSERT OR REPLACE INTO oui_metadata (key, value) VALUES ('lastUpdatedAt', ?)").run(new Date().toISOString());
    db.prepare("INSERT OR REPLACE INTO oui_metadata (key, value) VALUES ('source', ?)").run(IEEE_OUI_CSV_URL);

    const total = (db.prepare("SELECT COUNT(*) as cnt FROM oui_prefixes").get() as { cnt: number }).cnt;
    console.log(`[oui] Updated OUI database: ${updated} entries parsed, ${total} total`);
    return { updated, total };
  } catch (error) {
    console.error("[oui] Failed to update OUI database from IEEE:", error);
    // Ensure seed data is loaded as fallback
    if (!initialized) ensureSeedData();
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM oui_prefixes").get() as { cnt: number }).cnt;
    return { updated: 0, total: count };
  }
}

export function getOuiStats(): { entries: number; lastUpdated: string | null } {
  const db = getDb();
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM oui_prefixes").get() as { cnt: number }).cnt;
  const lastUpdate = db.prepare("SELECT value FROM oui_metadata WHERE key = 'lastUpdatedAt'").get() as { value: string } | undefined;
  return { entries: count, lastUpdated: lastUpdate?.value ?? null };
}
