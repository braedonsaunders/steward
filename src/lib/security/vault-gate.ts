import { vault } from "@/lib/security/vault";

export type VaultGateResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Ensure the vault is ready for provider operations.
 * The vault auto-initializes and auto-unlocks using OS-native key protection,
 * so this should always succeed unless there's a system-level issue.
 */
export async function ensureVaultReadyForProviders(): Promise<VaultGateResult> {
  if (vault.isUnlocked()) {
    return { ok: true };
  }

  const unlocked = await vault.ensureUnlocked();
  if (unlocked) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      "Vault failed to initialize. Check file permissions on the .steward/ directory.",
  };
}
