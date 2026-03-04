import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateStore } from "@/lib/state/store";

const scryptAsync = promisify(scrypt);
const execFileAsync = promisify(execFile);

interface VaultMeta {
  salt: string;
  initializedAt: string;
}

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
const vaultMetaFile = path.join(vaultDir, "vault.meta.json");
const vaultDataFile = path.join(vaultDir, "vault.enc.json");
const keychainService = process.env.STEWARD_KEYCHAIN_SERVICE ?? "com.steward.vault.passphrase";
const keychainAccount =
  process.env.STEWARD_KEYCHAIN_ACCOUNT ??
  `steward:${path.resolve(vaultDir)}`;

let unlockedKey: Buffer | undefined;
let cachedPayload: VaultPayload | undefined;
let autoUnlockSuppressed = false;

const ensureVaultDir = async () => {
  await mkdir(vaultDir, { recursive: true });
};

const deriveKey = async (passphrase: string, salt: Buffer): Promise<Buffer> => {
  const key = (await scryptAsync(passphrase, salt, 32)) as Buffer;
  return key;
};

const readMeta = async (): Promise<VaultMeta | undefined> => {
  await ensureVaultDir();
  try {
    const raw = await readFile(vaultMetaFile, "utf8");
    return JSON.parse(raw) as VaultMeta;
  } catch {
    return undefined;
  }
};

const writeMeta = async (meta: VaultMeta): Promise<void> => {
  await writeFile(vaultMetaFile, JSON.stringify(meta, null, 2), "utf8");
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

const canUseSystemKeychain = (): boolean => process.platform === "darwin";

const savePassphraseToKeychain = async (passphrase: string): Promise<void> => {
  if (!canUseSystemKeychain()) return;

  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w",
      passphrase,
    ]);
  } catch (error) {
    console.warn("Failed to persist vault passphrase to macOS keychain", error);
  }
};

const readPassphraseFromKeychain = async (): Promise<string | undefined> => {
  if (!canUseSystemKeychain()) return undefined;

  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w",
    ]);
    const passphrase = stdout.trim();
    return passphrase || undefined;
  } catch {
    return undefined;
  }
};

export const vault = {
  async isInitialized(): Promise<boolean> {
    const meta = await readMeta();
    return Boolean(meta);
  },

  async initialize(passphrase: string): Promise<void> {
    const existing = await readMeta();
    if (existing) {
      return;
    }

    const salt = randomBytes(16);
    await writeMeta({
      salt: salt.toString("base64"),
      initializedAt: new Date().toISOString(),
    });

    const key = await deriveKey(passphrase, salt);
    await writePayload(defaultPayload(), key);
    unlockedKey = key;
    cachedPayload = defaultPayload();
    autoUnlockSuppressed = false;
    await savePassphraseToKeychain(passphrase);
  },

  async unlock(passphrase: string): Promise<boolean> {
    const meta = await readMeta();
    if (!meta) {
      return false;
    }

    const key = await deriveKey(passphrase, Buffer.from(meta.salt, "base64"));
    const envelope = await readEnvelope();
    if (!envelope) {
      return false;
    }

    try {
      const payload = decryptPayload(envelope, key);
      unlockedKey = key;
      cachedPayload = payload;
      autoUnlockSuppressed = false;
      await savePassphraseToKeychain(passphrase);
      return true;
    } catch {
      return false;
    }
  },

  lock(): void {
    unlockedKey = undefined;
    cachedPayload = undefined;
    autoUnlockSuppressed = true;
  },

  isUnlocked(): boolean {
    return Boolean(unlockedKey && cachedPayload);
  },

  async ensureUnlocked(): Promise<boolean> {
    if (autoUnlockSuppressed) {
      return false;
    }

    if (this.isUnlocked()) {
      return true;
    }

    const envPassphrase = process.env.STEWARD_MASTER_PASSPHRASE;
    const initialized = await this.isInitialized();
    if (!initialized) {
      if (!envPassphrase) {
        return false;
      }
      await this.initialize(envPassphrase);
      return true;
    }

    if (envPassphrase) {
      return this.unlock(envPassphrase);
    }

    const keychainPassphrase = await readPassphraseFromKeychain();
    if (!keychainPassphrase) {
      return false;
    }

    return this.unlock(keychainPassphrase);
  },

  async setSecret(key: string, value: string): Promise<void> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked || !unlockedKey) {
      throw new Error("Vault is locked");
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

    const payload = cachedPayload;
    return payload?.secrets[key];
  },

  async deleteSecret(key: string): Promise<void> {
    const unlocked = await this.ensureUnlocked();
    if (!unlocked || !unlockedKey) {
      throw new Error("Vault is locked");
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
