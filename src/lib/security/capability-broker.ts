import { randomBytes, randomUUID } from "node:crypto";
import type { CapabilityToken, CapabilityTokenScope } from "@/lib/state/types";

interface StoredToken extends CapabilityToken {
  id: string;
}

class CapabilityBroker {
  private readonly store = new Map<string, StoredToken>();

  issue(scope: CapabilityTokenScope, ttlMs = 60_000): CapabilityToken {
    const now = Date.now();
    const tokenValue = `${randomUUID()}.${randomBytes(24).toString("base64url")}`;

    const entry: StoredToken = {
      id: randomUUID(),
      token: tokenValue,
      scope,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1_000, ttlMs)).toISOString(),
    };

    this.store.set(entry.token, entry);
    this.pruneExpired(now);

    return {
      token: entry.token,
      scope: entry.scope,
      issuedAt: entry.issuedAt,
      expiresAt: entry.expiresAt,
    };
  }

  validate(token: string, expected: CapabilityTokenScope): void {
    const entry = this.store.get(token);
    if (!entry) {
      throw new Error("Capability token missing or already consumed");
    }

    const now = Date.now();
    if (new Date(entry.expiresAt).getTime() <= now) {
      this.store.delete(token);
      throw new Error("Capability token expired");
    }

    const scopeMatches =
      entry.scope.deviceId === expected.deviceId
      && entry.scope.adapterId === expected.adapterId
      && entry.scope.mode === expected.mode
      && expected.operationKinds.every((kind) => entry.scope.operationKinds.includes(kind));

    if (!scopeMatches) {
      throw new Error("Capability token scope mismatch");
    }

    // Single-use capability tokens reduce blast radius.
    this.store.delete(token);
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, value] of this.store.entries()) {
      if (new Date(value.expiresAt).getTime() <= now) {
        this.store.delete(key);
      }
    }
  }
}

export const capabilityBroker = new CapabilityBroker();
