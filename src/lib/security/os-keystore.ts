/**
 * OS-native key protection for the vault encryption key.
 *
 * - Windows: DPAPI via PowerShell (no native modules needed)
 * - macOS:   Keychain via `security` CLI
 * - Fallback: machine-derived key via scrypt (Linux / WSL / unsupported)
 */

import { scrypt as scryptCb } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const scryptAsync = promisify(scryptCb);

const KEYCHAIN_SERVICE = "com.steward.vault-key";
const KEYCHAIN_ACCOUNT = "steward-vault-key";

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

async function macProtect(key: Buffer): Promise<Buffer> {
  const hex = key.toString("hex");
  try {
    // Delete existing entry first (ignore errors if it doesn't exist)
    await execFileAsync("security", [
      "delete-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
    ]).catch(() => {});

    await execFileAsync("security", [
      "add-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-w", hex,
    ]);
  } catch (error) {
    throw new Error(`Failed to store vault key in macOS Keychain: ${error}`);
  }

  // Return a marker so we know to read from keychain
  return Buffer.from("keychain:" + KEYCHAIN_SERVICE, "utf-8");
}

async function macUnprotect(_blob: Buffer): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-w",
    ]);
    return Buffer.from(stdout.trim(), "hex");
  } catch (error) {
    throw new Error(`Failed to read vault key from macOS Keychain: ${error}`);
  }
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

export async function protectKey(key: Buffer): Promise<Buffer> {
  switch (process.platform) {
    case "win32":
      return windowsProtect(key);
    case "darwin":
      return macProtect(key);
    default:
      return fallbackProtect(key);
  }
}

export async function unprotectKey(blob: Buffer): Promise<Buffer> {
  switch (process.platform) {
    case "win32":
      return windowsUnprotect(blob);
    case "darwin":
      return macUnprotect(blob);
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
