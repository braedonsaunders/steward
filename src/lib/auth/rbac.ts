import type { UserRole } from "@/lib/state/types";

export type RoutePermission = "public" | "read" | "operate" | "admin" | "owner" | "audit";

const ROLE_PERMISSIONS: Record<UserRole, Set<RoutePermission>> = {
  ReadOnly: new Set<RoutePermission>(["read"]),
  Auditor: new Set<RoutePermission>(["read", "audit"]),
  Operator: new Set<RoutePermission>(["read", "operate"]),
  Admin: new Set<RoutePermission>(["read", "operate", "admin", "audit"]),
  Owner: new Set<RoutePermission>(["read", "operate", "admin", "owner", "audit"]),
};

export function roleHasPermission(role: UserRole, permission: Exclude<RoutePermission, "public">): boolean {
  if (permission === "owner") {
    return role === "Owner";
  }

  const allowed = ROLE_PERMISSIONS[role];
  return allowed.has(permission) || allowed.has("owner");
}

export function permissionForApiRoute(pathname: string, method: string): RoutePermission {
  const route = pathname.toLowerCase();
  const verb = method.toUpperCase();

  if (route === "/api/health") return "public";
  if (route.startsWith("/api/auth/bootstrap")) return "public";
  if (route.startsWith("/api/auth/login")) return "public";
  if (route.startsWith("/api/auth/logout")) return "public";
  if (route.startsWith("/api/auth/me")) return "public";
  if (route.startsWith("/api/auth/oidc/start")) return "public";
  if (route.startsWith("/api/auth/oidc/callback")) return "public";
  if (route.startsWith("/api/gateway/telegram/") && route.endsWith("/webhook")) return "public";

  if (route.startsWith("/api/auth/users")) {
    return verb === "GET" ? "admin" : "owner";
  }
  if (route.startsWith("/api/auth/settings")) {
    return "admin";
  }
  if (route.startsWith("/api/auth/ldap/test")) {
    return "admin";
  }
  if (route.startsWith("/api/settings/auth-token")) {
    return "admin";
  }
  if (route.startsWith("/api/settings/runtime")) {
    return "admin";
  }
  if (route.startsWith("/api/settings/system")) {
    return "admin";
  }
  if (route.startsWith("/api/settings/history")) {
    return "audit";
  }
  if (route.startsWith("/api/providers/oauth/") || route === "/api/providers" || route.startsWith("/api/providers/disconnect")) {
    return "admin";
  }
  if (route.startsWith("/api/providers/models") || route.startsWith("/api/providers/status")) {
    return "read";
  }
  if (route.startsWith("/api/vault")) {
    return "admin";
  }
  if (route.startsWith("/api/audit-events")) {
    return "audit";
  }
  if (route.startsWith("/api/policies") || route.startsWith("/api/maintenance-windows") || route.startsWith("/api/adapters")) {
    if (verb === "GET") return "read";
    return "admin";
  }
  if (route.startsWith("/api/packs") || route.startsWith("/api/gateway/bindings")) {
    if (verb === "GET") return "read";
    return "admin";
  }
  if (route.startsWith("/api/agent/run")) {
    return "operate";
  }
  if (route.startsWith("/api/approvals")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/playbooks")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/incidents") || route.startsWith("/api/recommendations")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/missions") || route.startsWith("/api/subagents") || route.startsWith("/api/investigations") || route.startsWith("/api/briefings")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/devices")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/chat")) {
    return "operate";
  }
  if (route.startsWith("/api/digest")) {
    if (verb === "GET") return "read";
    return "operate";
  }
  if (route.startsWith("/api/state")) {
    return "read";
  }

  if (verb === "GET" || verb === "HEAD") {
    return "read";
  }
  return "operate";
}

