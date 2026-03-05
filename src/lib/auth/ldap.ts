import { Client } from "ldapts";
import type { AuthSettings } from "@/lib/state/types";

interface LdapResolvedUser {
  externalId: string;
  usernameHint: string;
  displayName: string;
}

function readAttr(entry: Record<string, unknown>, key: string): string | undefined {
  const value = entry[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return first;
    if (Buffer.isBuffer(first)) return first.toString("utf8");
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

function escapeLdapFilter(value: string): string {
  return value
    .replace(/\\/g, "\\5c")
    .replace(/\*/g, "\\2a")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\0/g, "\\00");
}

function buildUserFilter(template: string, username: string): string {
  const escaped = escapeLdapFilter(username);
  if (!template.includes("{{username}}")) {
    return template.trim();
  }
  return template.replaceAll("{{username}}", escaped).trim();
}

export async function authenticateViaLdap(
  ldap: AuthSettings["ldap"],
  username: string,
  password: string,
  bindPassword?: string,
): Promise<LdapResolvedUser> {
  if (!ldap.url || !ldap.baseDn) {
    throw new Error("LDAP is not fully configured.");
  }
  if (!password || password.length < 1) {
    throw new Error("LDAP password is required.");
  }

  const client = new Client({
    url: ldap.url,
    timeout: 8_000,
    connectTimeout: 8_000,
  });

  try {
    if (ldap.bindDn) {
      if (!bindPassword) {
        throw new Error("LDAP bind password is not configured.");
      }
      await client.bind(ldap.bindDn, bindPassword);
    }

    const filter = buildUserFilter(ldap.userFilter, username);
    const { searchEntries } = await client.search(ldap.baseDn, {
      filter,
      scope: "sub",
      attributes: [ldap.uidAttribute, "uid", "cn", "displayName", "mail"],
      sizeLimit: 2,
    });
    const entry = searchEntries[0] as (Record<string, unknown> & { dn?: string }) | undefined;
    if (!entry) {
      throw new Error("LDAP user not found.");
    }

    const userDn = typeof entry.dn === "string" ? entry.dn : "";
    if (!userDn) {
      throw new Error("LDAP user DN was not returned.");
    }

    await client.bind(userDn, password);

    const externalId = readAttr(entry, ldap.uidAttribute) || readAttr(entry, "uid") || userDn;
    const usernameHint = readAttr(entry, ldap.uidAttribute) || readAttr(entry, "uid") || username;
    const displayName = readAttr(entry, "displayName") || readAttr(entry, "cn") || usernameHint;

    return {
      externalId,
      usernameHint,
      displayName,
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}

export async function testLdapConnection(
  ldap: AuthSettings["ldap"],
  bindPassword?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ldap.url) {
    return { ok: false, error: "LDAP URL is required." };
  }

  const client = new Client({
    url: ldap.url,
    timeout: 8_000,
    connectTimeout: 8_000,
  });

  try {
    if (ldap.bindDn) {
      if (!bindPassword) {
        return { ok: false, error: "LDAP bind password is not configured." };
      }
      await client.bind(ldap.bindDn, bindPassword);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.unbind().catch(() => {});
  }
}

