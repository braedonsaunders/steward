import type { NextRequest } from "next/server";
import { getSessionUserByToken, countAuthUsers } from "@/lib/auth/identity";
import { permissionForApiRoute, roleHasPermission, type RoutePermission } from "@/lib/auth/rbac";
import { readSessionToken } from "@/lib/auth/session";
import { constantTimeEqualHex, hashApiToken } from "@/lib/auth/token";
import { stateStore } from "@/lib/state/store";
import type { AuthUser, UserRole } from "@/lib/state/types";

type IdentitySource = "token" | "session";

export interface AuthContext {
  authorized: boolean;
  status: 200 | 401 | 403;
  reason: string;
  permission: RoutePermission;
  role?: UserRole;
  user?: AuthUser;
  source?: IdentitySource;
}

function presentedApiToken(request: NextRequest): string {
  const bearer = request.headers.get("authorization") ?? "";
  const custom = request.headers.get("x-steward-token") ?? "";
  const queryToken = request.nextUrl.searchParams.get("steward_token") ?? "";
  return custom || (bearer.startsWith("Bearer ") ? bearer.replace("Bearer ", "") : "") || queryToken;
}

function resolveTokenIdentity(request: NextRequest): { role: UserRole; source: IdentitySource } | null {
  const requiredTokenHash = stateStore.getApiTokenHash();
  if (!requiredTokenHash) {
    return null;
  }

  const presented = presentedApiToken(request);
  if (!presented) {
    return null;
  }

  const presentedHash = hashApiToken(presented);
  const valid = constantTimeEqualHex(presentedHash, requiredTokenHash);
  if (!valid) {
    return null;
  }

  // API token is treated as service-owner authority.
  return { role: "Owner", source: "token" };
}

function resolveSessionIdentity(request: NextRequest): {
  role: UserRole;
  user: AuthUser;
  source: IdentitySource;
} | null {
  const token = readSessionToken(request);
  if (!token) {
    return null;
  }
  const sessionUser = getSessionUserByToken(token);
  if (!sessionUser) {
    return null;
  }
  return {
    role: sessionUser.user.role,
    user: sessionUser.user,
    source: "session",
  };
}

export function getAuthContext(request: NextRequest): AuthContext {
  const permission = permissionForApiRoute(request.nextUrl.pathname, request.method);
  if (permission === "public") {
    const tokenIdentity = resolveTokenIdentity(request);
    const sessionIdentity = resolveSessionIdentity(request);
    const identity = tokenIdentity ?? sessionIdentity;
    return {
      authorized: true,
      status: 200,
      reason: "public",
      permission,
      role: identity?.role,
      user: sessionIdentity?.user,
      source: identity?.source,
    };
  }

  const authSettings = stateStore.getAuthSettings();
  const usersCount = countAuthUsers();
  const hasUsers = usersCount > 0;
  const hasApiToken = Boolean(stateStore.getApiTokenHash());
  const firstRunOpen = !hasUsers && !hasApiToken;

  const tokenIdentity = resolveTokenIdentity(request);
  const sessionIdentity = resolveSessionIdentity(request);
  const identity = tokenIdentity ?? sessionIdentity;

  const mode = authSettings.mode;
  const modeRequiresToken = mode === "token";
  const modeRequiresSession = mode === "session";
  const modeOpen = mode === "open";

  if (!identity) {
    if (firstRunOpen || modeOpen) {
      // Bootstrap compatibility: first-run or explicitly open mode.
      return {
        authorized: true,
        status: 200,
        reason: firstRunOpen ? "first-run-open" : "open-mode",
        permission,
        role: "Owner",
      };
    }
    if (modeRequiresToken) {
      return {
        authorized: false,
        status: 401,
        reason: "api-token-required",
        permission,
      };
    }
    if (modeRequiresSession) {
      return {
        authorized: false,
        status: 401,
        reason: "session-required",
        permission,
      };
    }
    return {
      authorized: false,
      status: 401,
      reason: "authentication-required",
      permission,
    };
  }

  if (modeRequiresToken && identity.source !== "token") {
    return {
      authorized: false,
      status: 401,
      reason: "api-token-required",
      permission,
    };
  }

  if (modeRequiresSession && identity.source !== "session") {
    return {
      authorized: false,
      status: 401,
      reason: "session-required",
      permission,
    };
  }

  const allowed = roleHasPermission(identity.role, permission);
  if (!allowed) {
    return {
      authorized: false,
      status: 403,
      reason: `role-${identity.role}-missing-${permission}`,
      permission,
      role: identity.role,
      user: sessionIdentity?.user,
      source: identity.source,
    };
  }

  return {
    authorized: true,
    status: 200,
    reason: "authorized",
    permission,
    role: identity.role,
    user: sessionIdentity?.user,
    source: identity.source,
  };
}

export function isAuthorized(request: NextRequest): boolean {
  return getAuthContext(request).authorized;
}
