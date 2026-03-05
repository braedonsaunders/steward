import type { LlmHealthState } from "@/lib/state/types";

interface ProviderHealth {
  state: LlmHealthState;
  failures: number;
  lastChangedAt: string;
  lastFailureAt?: string;
}

class LlmHealthController {
  private readonly health = new Map<string, ProviderHealth>();

  getState(provider: string): ProviderHealth {
    return this.health.get(provider) ?? {
      state: "AVAILABLE",
      failures: 0,
      lastChangedAt: new Date().toISOString(),
    };
  }

  reportSuccess(provider: string): ProviderHealth {
    const next: ProviderHealth = {
      state: "AVAILABLE",
      failures: 0,
      lastChangedAt: new Date().toISOString(),
    };
    this.health.set(provider, next);
    return next;
  }

  reportFailure(provider: string, options?: { safeMode?: boolean }): ProviderHealth {
    const current = this.getState(provider);
    const failures = current.failures + 1;

    let state: LlmHealthState = "DEGRADED";
    if (options?.safeMode) {
      state = "SAFE_MODE";
    } else if (failures >= 5) {
      state = "UNAVAILABLE";
    } else if (failures >= 2) {
      state = "DEGRADED";
    }

    const next: ProviderHealth = {
      state,
      failures,
      lastChangedAt: new Date().toISOString(),
      lastFailureAt: new Date().toISOString(),
    };
    this.health.set(provider, next);
    return next;
  }

  laneBAllowed(provider: string): boolean {
    const state = this.getState(provider).state;
    return state === "AVAILABLE" || state === "DEGRADED";
  }
}

export const llmHealthController = new LlmHealthController();
