import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultState } from "@/lib/state/defaults";
import type {
  ActionLog,
  AgentRunRecord,
  Device,
  Incident,
  OAuthState,
  ProviderConfig,
  Recommendation,
  StewardState,
} from "@/lib/state/types";

const DATA_DIR = process.env.STEWARD_DATA_DIR ?? path.join(process.cwd(), ".steward");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const ensureStateFile = async () => {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(STATE_FILE, "utf8");
  } catch {
    await writeFile(STATE_FILE, JSON.stringify(defaultState(), null, 2), "utf8");
  }
};

const parseState = (raw: string): StewardState => {
  try {
    return JSON.parse(raw) as StewardState;
  } catch {
    return defaultState();
  }
};

class StateStore {
  private lock = Promise.resolve();

  private async readStateUnsafe(): Promise<StewardState> {
    await ensureStateFile();
    const raw = await readFile(STATE_FILE, "utf8");
    return parseState(raw);
  }

  private async writeStateUnsafe(state: StewardState): Promise<void> {
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release!();
    }
  }

  getState(): Promise<StewardState> {
    return this.withLock(async () => this.readStateUnsafe());
  }

  updateState(
    updater: (state: StewardState) => StewardState | Promise<StewardState>,
  ): Promise<StewardState> {
    return this.withLock(async () => {
      const current = await this.readStateUnsafe();
      const next = await updater(current);
      await this.writeStateUnsafe(next);
      return next;
    });
  }

  async addAction(log: Omit<ActionLog, "id" | "at">): Promise<void> {
    await this.updateState(async (state) => {
      state.actions.unshift({
        id: randomUUID(),
        at: new Date().toISOString(),
        ...log,
      });

      state.actions = state.actions.slice(0, 2000);
      return state;
    });
  }

  async upsertDevice(device: Device): Promise<Device> {
    await this.updateState(async (state) => {
      const idx = state.devices.findIndex((d) => d.id === device.id);
      if (idx === -1) {
        state.devices.push(device);
      } else {
        state.devices[idx] = device;
      }
      return state;
    });

    return device;
  }

  async setIncidents(incidents: Incident[]): Promise<void> {
    await this.updateState(async (state) => {
      state.incidents = incidents;
      return state;
    });
  }

  async setRecommendations(recommendations: Recommendation[]): Promise<void> {
    await this.updateState(async (state) => {
      state.recommendations = recommendations;
      return state;
    });
  }

  async setProviderConfig(config: ProviderConfig): Promise<void> {
    await this.updateState(async (state) => {
      const idx = state.providerConfigs.findIndex((p) => p.provider === config.provider);
      if (idx === -1) {
        state.providerConfigs.push(config);
      } else {
        state.providerConfigs[idx] = {
          ...state.providerConfigs[idx],
          ...config,
        };
      }
      return state;
    });
  }

  async createOAuthState(stateItem: Omit<OAuthState, "id" | "createdAt">): Promise<OAuthState> {
    const created: OAuthState = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...stateItem,
    };

    await this.updateState(async (state) => {
      state.oauthStates = state.oauthStates
        .filter((item) => new Date(item.expiresAt).getTime() > Date.now())
        .slice(0, 100);
      state.oauthStates.push(created);
      return state;
    });

    return created;
  }

  async consumeOAuthState(id: string): Promise<OAuthState | undefined> {
    let result: OAuthState | undefined;

    await this.updateState(async (state) => {
      const match = state.oauthStates.find((item) => item.id === id);
      if (match) {
        result = match;
      }
      state.oauthStates = state.oauthStates.filter((item) => item.id !== id);
      return state;
    });

    if (!result) {
      return undefined;
    }

    if (new Date(result.expiresAt).getTime() < Date.now()) {
      return undefined;
    }

    return result;
  }

  async addAgentRun(run: AgentRunRecord): Promise<void> {
    await this.updateState(async (state) => {
      state.agentRuns.unshift(run);
      state.agentRuns = state.agentRuns.slice(0, 200);
      return state;
    });
  }

  getDataDir(): string {
    return DATA_DIR;
  }

  getStateFile(): string {
    return STATE_FILE;
  }
}

export const stateStore = new StateStore();
