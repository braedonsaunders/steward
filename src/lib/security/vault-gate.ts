import { vault } from "@/lib/security/vault";

export const VAULT_NOT_INITIALIZED_MESSAGE =
  "Vault is not initialized. Initialize it in Settings > Vault before configuring providers.";
export const VAULT_LOCKED_MESSAGE =
  "Vault is locked. Unlock it in Settings > Vault before configuring providers.";

export type VaultGateResult =
  | { ok: true }
  | {
      ok: false;
      code: "VAULT_NOT_INITIALIZED" | "VAULT_LOCKED";
      error: string;
    };

/**
 * Provider configuration and OAuth flows require write access to the vault.
 */
export async function ensureVaultReadyForProviders(): Promise<VaultGateResult> {
  const initialized = await vault.isInitialized();
  if (!initialized) {
    return {
      ok: false,
      code: "VAULT_NOT_INITIALIZED",
      error: VAULT_NOT_INITIALIZED_MESSAGE,
    };
  }

  if (vault.isUnlocked()) {
    return { ok: true };
  }

  const unlocked = await vault.ensureUnlocked();
  if (!unlocked) {
    return {
      ok: false,
      code: "VAULT_LOCKED",
      error: VAULT_LOCKED_MESSAGE,
    };
  }

  return { ok: true };
}
