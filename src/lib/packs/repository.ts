import type Database from "better-sqlite3";
import { autonomyStore } from "@/lib/autonomy/store";
import type { PackRecord, PackSignerRecord } from "@/lib/autonomy/types";
import { getDb, recoverCorruptDatabase } from "@/lib/state/db";

function packSignerFromRow(row: Record<string, unknown>): PackSignerRecord {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    publicKeyPem: String(row.publicKeyPem),
    algorithm: "ed25519",
    trustScope: String(row.trustScope) as PackSignerRecord["trustScope"],
    enabled: Boolean(row.enabled),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

class PackRepository {
  private withDbRecovery<T>(context: string, operation: (db: Database.Database) => T): T {
    const run = () => operation(getDb());

    try {
      return run();
    } catch (error) {
      if (!recoverCorruptDatabase(error, context)) {
        throw error;
      }
      return run();
    }
  }

  list(): PackRecord[] {
    return autonomyStore.listPacks();
  }

  listSummaries() {
    return autonomyStore.listPackSummaries();
  }

  getById(id: string): PackRecord | undefined {
    return autonomyStore.getPackById(id);
  }

  upsert(pack: PackRecord): PackRecord {
    return autonomyStore.upsertPack(pack);
  }

  uninstall(id: string): PackRecord | undefined {
    return autonomyStore.uninstallPack(id);
  }

  listResources(packId: string) {
    return autonomyStore.listPackResources(packId);
  }

  listVersions(packId: string) {
    return autonomyStore.listPackVersions(packId);
  }

  listSigners(): PackSignerRecord[] {
    return this.withDbRecovery("PackRepository.listSigners", (db) =>
      (db.prepare(`
        SELECT * FROM pack_signers
        ORDER BY enabled DESC, name ASC
      `).all() as Record<string, unknown>[]).map(packSignerFromRow),
    );
  }

  getSignerById(id: string): PackSignerRecord | undefined {
    return this.withDbRecovery("PackRepository.getSignerById", (db) => {
      const row = db.prepare("SELECT * FROM pack_signers WHERE id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      return row ? packSignerFromRow(row) : undefined;
    });
  }

  getSignerBySlug(slug: string): PackSignerRecord | undefined {
    return this.withDbRecovery("PackRepository.getSignerBySlug", (db) => {
      const row = db.prepare("SELECT * FROM pack_signers WHERE slug = ? LIMIT 1").get(slug) as Record<string, unknown> | undefined;
      return row ? packSignerFromRow(row) : undefined;
    });
  }

  upsertSigner(signer: PackSignerRecord): PackSignerRecord {
    return this.withDbRecovery("PackRepository.upsertSigner", (db) => {
      db.prepare(`
        INSERT OR REPLACE INTO pack_signers (
          id, slug, name, publicKeyPem, algorithm, trustScope, enabled, createdAt, updatedAt
        )
        VALUES (
          @id, @slug, @name, @publicKeyPem, @algorithm, @trustScope, @enabled, @createdAt, @updatedAt
        )
      `).run({
        ...signer,
        enabled: signer.enabled ? 1 : 0,
      });
      return signer;
    });
  }

  deleteSigner(id: string): boolean {
    return this.withDbRecovery("PackRepository.deleteSigner", (db) => {
      const result = db.prepare("DELETE FROM pack_signers WHERE id = ?").run(id);
      return Number(result.changes ?? 0) > 0;
    });
  }
}

export const packRepository = new PackRepository();
