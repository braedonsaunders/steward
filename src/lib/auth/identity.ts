import { randomUUID } from "node:crypto";
import { hashApiToken } from "@/lib/auth/token";
import { verifyPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/state/db";
import type { AuthProviderType, AuthSession, AuthUser, UserRole } from "@/lib/state/types";

interface AuthUserRow {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  provider: AuthProviderType;
  externalId: string | null;
  disabled: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface AuthSessionRow {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

function userFromRow(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    provider: row.provider,
    externalId: row.externalId ?? undefined,
    disabled: Boolean(row.disabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt ?? undefined,
  };
}

function sessionFromRow(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    ip: row.ip ?? undefined,
    userAgent: row.userAgent ?? undefined,
  };
}

function validUsername(value: string): boolean {
  return /^[a-zA-Z0-9._-]{3,64}$/.test(value);
}

function ensureUniqueUsername(base: string): string {
  const db = getDb();
  const fallback = base.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 64) || "user";
  const exists = db.prepare("SELECT id FROM auth_users WHERE username = ?").get(fallback) as { id: string } | undefined;
  if (!exists) return fallback;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${fallback.slice(0, 60)}-${i}`;
    const hit = db.prepare("SELECT id FROM auth_users WHERE username = ?").get(candidate) as { id: string } | undefined;
    if (!hit) return candidate;
  }
  return `${fallback.slice(0, 52)}-${randomUUID().slice(0, 8)}`;
}

export function countAuthUsers(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM auth_users").get() as { count: number };
  return Number(row.count ?? 0);
}

export function listAuthUsers(): AuthUser[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, username, displayName, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt
    FROM auth_users
    ORDER BY createdAt ASC
  `).all() as AuthUserRow[];
  return rows.map(userFromRow);
}

export function getAuthUserById(id: string): AuthUser | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, displayName, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt
    FROM auth_users
    WHERE id = ?
  `).get(id) as AuthUserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function getAuthUserByUsername(username: string): AuthUser | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, displayName, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt
    FROM auth_users
    WHERE username = ?
  `).get(username.trim().toLowerCase()) as AuthUserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function createLocalUser(input: {
  username: string;
  displayName?: string;
  passwordHash: string;
  role: UserRole;
}): AuthUser {
  const username = input.username.trim().toLowerCase();
  if (!validUsername(username)) {
    throw new Error("Username must be 3-64 chars and contain only letters, numbers, dot, underscore, or dash.");
  }

  const db = getDb();
  const now = new Date().toISOString();
  const user: AuthUser = {
    id: randomUUID(),
    username,
    displayName: input.displayName?.trim() || username,
    role: input.role,
    provider: "local",
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO auth_users (id, username, displayName, passwordHash, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt)
    VALUES (@id, @username, @displayName, @passwordHash, @role, 'local', NULL, 0, @createdAt, @updatedAt, NULL)
  `).run({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    passwordHash: input.passwordHash,
    role: user.role,
    createdAt: now,
    updatedAt: now,
  });

  return user;
}

export function updateAuthUser(
  id: string,
  patch: Partial<Pick<AuthUser, "displayName" | "role" | "disabled">>,
): AuthUser | null {
  const db = getDb();
  const existing = getAuthUserById(id);
  if (!existing) return null;

  const updated: AuthUser = {
    ...existing,
    displayName: patch.displayName?.trim() || existing.displayName,
    role: patch.role ?? existing.role,
    disabled: typeof patch.disabled === "boolean" ? patch.disabled : existing.disabled,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE auth_users
    SET displayName = ?, role = ?, disabled = ?, updatedAt = ?
    WHERE id = ?
  `).run(updated.displayName, updated.role, updated.disabled ? 1 : 0, updated.updatedAt, id);

  return updated;
}

export function deleteAuthUser(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM auth_users WHERE id = ?").run(id);
  return result.changes > 0;
}

export function verifyLocalLogin(username: string, password: string): AuthUser | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, displayName, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt, passwordHash
    FROM auth_users
    WHERE username = ? AND provider = 'local'
  `).get(username.trim().toLowerCase()) as (AuthUserRow & { passwordHash: string | null }) | undefined;
  if (!row || row.disabled || !row.passwordHash) return null;
  if (!verifyPassword(password, row.passwordHash)) return null;
  return userFromRow(row);
}

export function getAuthUserByProviderExternal(provider: AuthProviderType, externalId: string): AuthUser | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, username, displayName, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt
    FROM auth_users
    WHERE provider = ? AND externalId = ?
  `).get(provider, externalId) as AuthUserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function upsertFederatedUser(input: {
  provider: Extract<AuthProviderType, "oidc" | "ldap">;
  externalId: string;
  usernameHint: string;
  displayName: string;
  defaultRole: UserRole;
}): AuthUser {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getAuthUserByProviderExternal(input.provider, input.externalId);
  if (existing) {
    const displayName = input.displayName.trim() || existing.displayName;
    const username = existing.username;
    db.prepare(`
      UPDATE auth_users
      SET displayName = ?, username = ?, updatedAt = ?
      WHERE id = ?
    `).run(displayName, username, now, existing.id);
    return {
      ...existing,
      displayName,
      updatedAt: now,
    };
  }

  const usernameBase = input.usernameHint.trim().toLowerCase();
  const username = validUsername(usernameBase)
    ? ensureUniqueUsername(usernameBase)
    : ensureUniqueUsername(input.displayName || "user");

  const created: AuthUser = {
    id: randomUUID(),
    username,
    displayName: input.displayName.trim() || username,
    role: input.defaultRole,
    provider: input.provider,
    externalId: input.externalId,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO auth_users (id, username, displayName, passwordHash, role, provider, externalId, disabled, createdAt, updatedAt, lastLoginAt)
    VALUES (@id, @username, @displayName, NULL, @role, @provider, @externalId, 0, @createdAt, @updatedAt, NULL)
  `).run({
    id: created.id,
    username: created.username,
    displayName: created.displayName,
    role: created.role,
    provider: created.provider,
    externalId: created.externalId,
    createdAt: created.createdAt,
    updatedAt: created.updatedAt,
  });

  return created;
}

export function touchAuthUserLogin(userId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE auth_users SET lastLoginAt = ?, updatedAt = ? WHERE id = ?").run(now, now, userId);
}

export function createAuthSession(input: {
  userId: string;
  tokenHash: string;
  ttlHours: number;
  ip?: string;
  userAgent?: string;
}): AuthSession {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlHours) * 60 * 60 * 1000).toISOString();
  const session: AuthSession = {
    id: randomUUID(),
    userId: input.userId,
    createdAt: now.toISOString(),
    expiresAt,
    lastSeenAt: now.toISOString(),
    ip: input.ip,
    userAgent: input.userAgent,
  };

  db.prepare(`
    INSERT INTO auth_sessions (id, userId, tokenHash, createdAt, expiresAt, lastSeenAt, ip, userAgent)
    VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt, @lastSeenAt, @ip, @userAgent)
  `).run({
    id: session.id,
    userId: session.userId,
    tokenHash: input.tokenHash,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    ip: session.ip ?? null,
    userAgent: session.userAgent ?? null,
  });

  return session;
}

export function deleteSessionByToken(token: string): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions WHERE tokenHash = ?").run(hashApiToken(token));
}

export function deleteSessionById(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
}

export function deleteSessionsByUserId(userId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM auth_sessions WHERE userId = ?").run(userId);
}

export function getSessionUserByToken(token: string): { user: AuthUser; session: AuthSession } | null {
  const db = getDb();
  const tokenHash = hashApiToken(token);
  const row = db.prepare(`
    SELECT
      s.id as id,
      s.userId as userId,
      s.tokenHash as tokenHash,
      s.createdAt as createdAt,
      s.expiresAt as expiresAt,
      s.lastSeenAt as lastSeenAt,
      s.ip as ip,
      s.userAgent as userAgent,
      u.id as "u.id",
      u.username as "u.username",
      u.displayName as "u.displayName",
      u.role as "u.role",
      u.provider as "u.provider",
      u.externalId as "u.externalId",
      u.disabled as "u.disabled",
      u.createdAt as "u.createdAt",
      u.updatedAt as "u.updatedAt",
      u.lastLoginAt as "u.lastLoginAt"
    FROM auth_sessions s
    JOIN auth_users u ON u.id = s.userId
    WHERE s.tokenHash = ?
    LIMIT 1
  `).get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) return null;

  const now = Date.now();
  const expiresAt = Date.parse(String(row.expiresAt));
  const disabled = Boolean(row["u.disabled"]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || disabled) {
    db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(String(row.id));
    return null;
  }

  const refreshedAt = new Date().toISOString();
  db.prepare("UPDATE auth_sessions SET lastSeenAt = ? WHERE id = ?").run(refreshedAt, String(row.id));

  const user: AuthUser = {
    id: String(row["u.id"]),
    username: String(row["u.username"]),
    displayName: String(row["u.displayName"]),
    role: row["u.role"] as UserRole,
    provider: row["u.provider"] as AuthProviderType,
    externalId: row["u.externalId"] ? String(row["u.externalId"]) : undefined,
    disabled: Boolean(row["u.disabled"]),
    createdAt: String(row["u.createdAt"]),
    updatedAt: String(row["u.updatedAt"]),
    lastLoginAt: row["u.lastLoginAt"] ? String(row["u.lastLoginAt"]) : undefined,
  };

  const session: AuthSession = sessionFromRow({
    id: String(row.id),
    userId: String(row.userId),
    createdAt: String(row.createdAt),
    expiresAt: String(row.expiresAt),
    lastSeenAt: refreshedAt,
    ip: row.ip ? String(row.ip) : null,
    userAgent: row.userAgent ? String(row.userAgent) : null,
  });

  return { user, session };
}

export function createOidcState(input: {
  id: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO auth_oidc_states (id, codeVerifier, nonce, redirectUri, createdAt, expiresAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.codeVerifier,
    input.nonce,
    input.redirectUri,
    new Date().toISOString(),
    input.expiresAt,
  );
}

export function consumeOidcState(id: string): {
  id: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
} | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, codeVerifier, nonce, redirectUri, createdAt, expiresAt
    FROM auth_oidc_states
    WHERE id = ?
  `).get(id) as {
    id: string;
    codeVerifier: string;
    nonce: string;
    redirectUri: string;
    createdAt: string;
    expiresAt: string;
  } | undefined;

  db.prepare("DELETE FROM auth_oidc_states WHERE id = ?").run(id);

  if (!row) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) {
    return null;
  }
  return row;
}
