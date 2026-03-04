/**
 * Vault — encrypted secret storage using OS-native key protection.
 *
 * Encryption key is a random 32-byte key protected by:
 * - Windows: DPAPI (tied to Windows user login)
 * - macOS: Keychain
 * - Fallback: machine-derived key
 *
 * Secrets are encrypted with AES-256-GCM and stored in .steward/vault.enc.json.
 * The protected encryption key is stored in .steward/vault.key.
 *
 * No passphrase is ever required — the vault auto-initializes and auto-unlocks.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import path from "node:path";
import { stateStore } from "@/lib/state/store";
import { protectKey, unprotectKey } from "@/lib/security/os-keystore";

interface VaultPayload {
  version: number;
  updatedAt: string;
  secrets: Record<string, string>;
}

interface EncryptedEnvelope {
  iv: string;
  authTag: string;
  ciphertext: string;
}

const vaultDir = stateStore.getDataDir();
const vaultKeyFile = path.join(vaultDir, "vault.key");
const vaultDataFile = path.join(vaultDir, "vault.enc.json");

// Legacy files from the old passphrase-based vault
const legacyMetaFile = path.join(vaultDir, "vault.meta.json");

let unlockedKey: Buffer | undefined;
let cachedPayload: VaultPayload | undefined;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ensureVaultDir = async () => {
  await mkdir(vaultDir, { recursive: true });
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const encryptPayload = (payload: VaultPayload, key: Buffer): EncryptedEnvelope => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
};

const decryptPayload = (envelope: EncryptedEnvelope, key: Buffer): VaultPayload => {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as VaultPayload;
};

const defaultPayload = (): VaultPayload => ({
  version: 1,
  updatedAt: new Date().toISOString(),
  secrets: {},
});

const readEnvelope = async (): Promise<EncryptedEnvelope | undefined> => {
  try {
    const raw = await readFile(vaultDataFile, "utf8");
    return JSON.parse(raw) as EncryptedEnvelope;
  } catch {
    return undefined;
  }
};

const writePayload = async (payload: VaultPayload, key: Buffer): Promise<void> => {
  await ensureVaultDir();
  const envelope = encryptPayload(payload, key);
  await writeFile(vaultDataFile, JSON.stringify(envelope, null, 2), "utf8");
};

/**
 * Remove legacy passphrase-based vault files.
 * Safe to call even if they don't exist.
 */
const removeLegacyVault = async (): Promise<void> => {
  await unlink(legacyMetaFile).catch(() => {});
  // Also remove old encrypted data since it's keyed to the old passphrase
  await unlink(vaultDataFile).catch(() => {});
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const vault = {
  async isInitialized(): Promise<boolean> {
    return fileExists(vaultKeyFile);
  },

  isUnlocked(): boolean {
    return Boolean(unlockedKey && cachedPayload);
  },

  /**
   * Auto-initialize and auto-unlock the vault. No user interaction needed.
   *
   * 1. If legacy vault exists, remove it and start fresh
   * 2. If vault.key doesn't exist, generate a new random key and protect it
   * 3. Read the protected key, unprotect it, decrypt the payload
   */
  async ensureUnlocked(): Promise<boolean> {
    if (this.isUnlocked()) {
      return true;
    }

    try {
      await ensureVaultDir();

      // Migrate from legacy passphrase vault
      const hasLegacy = await fileExists(legacyMetaFile);
      const hasNewKey = await fileExists(vaultKeyFile);

      if (hasLegacy && !hasNewKey) {
        await removeLegacyVault();
      }

      // Initialize if needed
      if (!await fileExists(vaultKeyFile)) {
        const rawKey = randomBytes(32);
        const protectedBlob = await protectKey(rawKey);
        await writeFile(vaultKeyFile, protectedBlob);
        await writePayload(defaultPayload(), rawKey);
        unlockedKey = rawKey;
        cachedPayload = defaultPayload();
        return true;
      }

      // Unlock — read protected key, unprotect, decrypt payload
      const protectedBlob = await readFile(vaultKeyFile);
      const rawKey = await unprotectKey(protectedBlob);
      unlockedKey = rawKey;

      const envelope = await readEnvelope();
      if (envelope) {
        cachedPayload = decryptPayload(envelope, rawKey);
      } else {
        // Key file exists but no data file — create empty payload
        cachedPayload = defaultPayload();
        await writePayload(cachedPayload, rawKey);
      }

      return true;
    } catch (error) {
      console.error("Vault auto-unlock failed:", error);
      unlockedKey = undefined;
      cachedPayload = undefined;
      return false;
    }
  },

  async setSecret(key: string, value: string): Promise<void> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked || !unlockedKey) {
      throw new Error("Vault is not available");
    }

    const payload = cachedPayload ?? defaultPayload();
    payload.secrets[key] = value;
    payload.updatedAt = new Date().toISOString();

    await writePayload(payload, unlockedKey);
    cachedPayload = payload;
  },

  async getSecret(key: string): Promise<string | undefined> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked) {
      return undefined;
    }

    return cachedPayload?.secrets[key];
  },

  async deleteSecret(key: string): Promise<void> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked || !unlockedKey) {
      throw new Error("Vault is not available");
    }

    const payload = cachedPayload ?? defaultPayload();
    delete payload.secrets[key];
    payload.updatedAt = new Date().toISOString();

    await writePayload(payload, unlockedKey);
    cachedPayload = payload;
  },

  async listSecretKeys(): Promise<string[]> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked) {
      return [];
    }

    return Object.keys(cachedPayload?.secrets ?? {}).sort();
  },
};
