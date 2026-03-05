/**
 * OS-native key protection for the vault encryption key.
 *
 * - Windows: DPAPI via PowerShell (no native modules needed)
 * - macOS:   Keychain via `security` CLI
 * - Fallback: machine-derived key via scrypt (Linux / WSL / unsupported)
 */

import { createHash, scrypt as scryptCb } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(scryptCb);

const LEGACY_KEYCHAIN_SERVICE = "com.steward.vault-key";
const LEGACY_KEYCHAIN_ACCOUNT = "steward-vault-key";
const KEYCHAIN_MARKER_PREFIX = "keychain:v2:";

function scopedKeychainIdentity(scope?: string): { service: string; account: string } {
  if (!scope) {
    return {
      service: LEGACY_KEYCHAIN_SERVICE,
      account: LEGACY_KEYCHAIN_ACCOUNT,
    };
  }

  const normalizedScope = process.platform === "win32" ? scope.toLowerCase() : scope;
  const suffix = createHash("sha256").update(normalizedScope).digest("hex").slice(0, 16);
  return {
    service: `${LEGACY_KEYCHAIN_SERVICE}.${suffix}`,
    account: `${LEGACY_KEYCHAIN_ACCOUNT}.${suffix}`,
  };
}

function parseKeychainMarker(blob: Buffer): { service: string; account: string } | null {
  const marker = blob.toString("utf8");
  if (marker.startsWith(KEYCHAIN_MARKER_PREFIX)) {
    const encoded = marker.slice(KEYCHAIN_MARKER_PREFIX.length);
    const separator = encoded.indexOf(":");
    if (separator > 0 && separator < encoded.length - 1) {
      return {
        service: encoded.slice(0, separator),
        account: encoded.slice(separator + 1),
      };
    }
  }

  if (marker.startsWith("keychain:")) {
    const service = marker.slice("keychain:".length).trim();
    return {
      service: service || LEGACY_KEYCHAIN_SERVICE,
      account: LEGACY_KEYCHAIN_ACCOUNT,
    };
  }

  return null;
}

async function readKeychainSecret(service: string, account: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-a", account,
    "-s", service,
    "-w",
  ]);
  return Buffer.from(stdout.trim(), "hex");
}

// ---------------------------------------------------------------------------
// Windows — DPAPI via PowerShell (works on any Node version)
// ---------------------------------------------------------------------------

async function windowsProtect(key: Buffer): Promise<Buffer> {
  const b64 = key.toString("base64");
  const cmd =
    "Add-Type -AssemblyName System.Security; " +
    `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String("${b64}"), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]);
  return Buffer.from(stdout.trim(), "base64");
}

async function windowsUnprotect(blob: Buffer): Promise<Buffer> {
  const b64 = blob.toString("base64");
  const cmd =
    "Add-Type -AssemblyName System.Security; " +
    `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String("${b64}"), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]);
  return Buffer.from(stdout.trim(), "base64");
}

// ---------------------------------------------------------------------------
// macOS — Keychain
// ---------------------------------------------------------------------------

async function macProtect(key: Buffer, scope?: string): Promise<Buffer> {
  const { service, account } = scopedKeychainIdentity(scope);
  const hex = key.toString("hex");
  try {
    // Delete existing entry first (ignore errors if it doesn't exist)
    await execFileAsync("security", [
      "delete-generic-password",
      "-a", account,
      "-s", service,
    ]).catch(() => {});

    await execFileAsync("security", [
      "add-generic-password",
      "-a", account,
      "-s", service,
      "-w", hex,
    ]);
  } catch (error) {
    throw new Error(`Failed to store vault key in macOS Keychain: ${error}`);
  }

  return Buffer.from(`${KEYCHAIN_MARKER_PREFIX}${service}:${account}`, "utf8");
}

async function macUnprotect(blob: Buffer, scope?: string): Promise<Buffer> {
  const identities: Array<{ service: string; account: string }> = [];
  const markerIdentity = parseKeychainMarker(blob);
  if (markerIdentity) {
    identities.push(markerIdentity);
  }
  if (scope) {
    identities.push(scopedKeychainIdentity(scope));
  }
  identities.push({
    service: LEGACY_KEYCHAIN_SERVICE,
    account: LEGACY_KEYCHAIN_ACCOUNT,
  });

  const seen = new Set<string>();
  let lastError: unknown;
  for (const identity of identities) {
    const key = `${identity.service}:${identity.account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      return await readKeychainSecret(identity.service, identity.account);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to read vault key from macOS Keychain: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Fallback — machine-derived key (Linux, WSL, unsupported platforms)
// ---------------------------------------------------------------------------

function getMachineEntropy(): string {
  const user = os.userInfo().username;
  const host = os.hostname();
  const home = os.homedir();
  return `steward-vault:${user}@${host}:${home}`;
}

async function fallbackProtect(key: Buffer): Promise<Buffer> {
  // XOR the vault key with a machine-derived key so it's not plaintext on disk.
  // This is NOT cryptographically strong — any process as the same user can
  // replicate this. It prevents casual file browsing and is honest about its
  // security properties (better than a hardcoded passphrase).
  const entropy = getMachineEntropy();
  const derivedKey = (await scryptAsync(entropy, "steward-fallback-salt", 32)) as Buffer;

  const protected_ = Buffer.alloc(key.length);
  for (let i = 0; i < key.length; i++) {
    protected_[i] = key[i] ^ derivedKey[i % derivedKey.length];
  }
  return protected_;
}

async function fallbackUnprotect(blob: Buffer): Promise<Buffer> {
  // Reverse the XOR
  return fallbackProtect(blob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function protectKey(key: Buffer, scope?: string): Promise<Buffer> {
  switch (process.platform) {
    case "win32":
      return windowsProtect(key);
    case "darwin":
      return macProtect(key, scope);
    default:
      return fallbackProtect(key);
  }
}

export async function unprotectKey(blob: Buffer, scope?: string): Promise<Buffer> {
  switch (process.platform) {
    case "win32":
      return windowsUnprotect(blob);
    case "darwin":
      return macUnprotect(blob, scope);
    default:
      return fallbackUnprotect(blob);
  }
}

export function platformName(): string {
  switch (process.platform) {
    case "win32":
      return "Windows DPAPI";
    case "darwin":
      return "macOS Keychain";
    default:
      return "machine-derived key";
  }
}
