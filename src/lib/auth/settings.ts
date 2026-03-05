import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";
import type { AuthSettings } from "@/lib/state/types";

export const OIDC_CLIENT_SECRET_KEY = "auth.oidc.clientSecret";
export const LDAP_BIND_PASSWORD_KEY = "auth.ldap.bindPassword";

export async function getAuthSettingsWithSecretFlags(): Promise<AuthSettings> {
  const settings = stateStore.getAuthSettings();
  const [oidcSecret, ldapSecret] = await Promise.all([
    vault.getSecret(OIDC_CLIENT_SECRET_KEY),
    vault.getSecret(LDAP_BIND_PASSWORD_KEY),
  ]);

  return {
    ...settings,
    oidc: {
      ...settings.oidc,
      clientSecretConfigured: Boolean(oidcSecret),
    },
    ldap: {
      ...settings.ldap,
      bindPasswordConfigured: Boolean(ldapSecret),
    },
  };
}

export async function getOidcClientSecret(): Promise<string | undefined> {
  return vault.getSecret(OIDC_CLIENT_SECRET_KEY);
}

export async function getLdapBindPassword(): Promise<string | undefined> {
  return vault.getSecret(LDAP_BIND_PASSWORD_KEY);
}

export async function setAuthSecrets(input: {
  oidcClientSecret?: string | null;
  ldapBindPassword?: string | null;
}): Promise<void> {
  if (input.oidcClientSecret !== undefined) {
    if (input.oidcClientSecret === null || input.oidcClientSecret.length === 0) {
      await vault.deleteSecret(OIDC_CLIENT_SECRET_KEY);
    } else {
      await vault.setSecret(OIDC_CLIENT_SECRET_KEY, input.oidcClientSecret);
    }
  }

  if (input.ldapBindPassword !== undefined) {
    if (input.ldapBindPassword === null || input.ldapBindPassword.length === 0) {
      await vault.deleteSecret(LDAP_BIND_PASSWORD_KEY);
    } else {
      await vault.setSecret(LDAP_BIND_PASSWORD_KEY, input.ldapBindPassword);
    }
  }
}
