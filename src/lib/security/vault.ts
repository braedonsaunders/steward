import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateStore } from "@/lib/state/store";

const scryptAsync = promisify(scrypt);

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

let unlockedKey: Buffer | undefined;
let cachedPayload: VaultPayload | undefined;

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
      return true;
    } catch {
      return false;
    }
  },

  lock(): void {
    unlockedKey = undefined;
    cachedPayload = undefined;
  },

  isUnlocked(): boolean {
    return Boolean(unlockedKey && cachedPayload);
  },

  async ensureUnlocked(): Promise<boolean> {
    if (this.isUnlocked()) {
      return true;
    }

    const envPassphrase = process.env.STEWARD_MASTER_PASSPHRASE;
    if (!envPassphrase) {
      return false;
    }

    const initialized = await this.isInitialized();
    if (!initialized) {
      await this.initialize(envPassphrase);
      return true;
    }

    return this.unlock(envPassphrase);
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
