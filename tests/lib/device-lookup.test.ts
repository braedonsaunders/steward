import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "@/lib/state/types";

const { mockStateStore } = vi.hoisted(() => ({
  mockStateStore: {
    getDeviceById: vi.fn(),
    getDevices: vi.fn(),
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: mockStateStore,
}));

import { resolveDeviceByTarget } from "@/lib/devices/lookup";

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "device-1",
    name: "Device 1",
    ip: "10.0.0.10",
    hostname: null,
    mac: null,
    vendor: null,
    os: null,
    role: null,
    type: "server",
    status: "online",
    autonomyTier: 1,
    environmentLabel: "lab",
    tags: [],
    protocols: ["ssh"],
    services: [],
    firstSeenAt: "2026-03-19T00:00:00.000Z",
    lastSeenAt: "2026-03-19T00:00:00.000Z",
    lastChangedAt: "2026-03-19T00:00:00.000Z",
    metadata: {},
    secondaryIps: [],
    siteId: "site.local.default",
    ...overrides,
  };
}

describe("resolveDeviceByTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStateStore.getDeviceById.mockReturnValue(null);
    mockStateStore.getDevices.mockReturnValue([]);
  });

  it("resolves a literal IP exactly even when multiple devices share the same first octet", async () => {
    const gitlab = buildDevice({
      id: "gitlab-1",
      name: "GitLab Server (10.0.0.64)",
      ip: "10.0.0.64",
      type: "container-host",
    });

    mockStateStore.getDevices.mockReturnValue([
      buildDevice({ id: "device-a", name: "NAS (10.0.0.12)", ip: "10.0.0.12" }),
      gitlab,
      buildDevice({ id: "device-b", name: "Router (10.0.0.1)", ip: "10.0.0.1" }),
    ]);

    await expect(resolveDeviceByTarget("10.0.0.64")).resolves.toEqual(gitlab);
  });

  it("falls back to the attached device when no target is supplied", async () => {
    const attached = buildDevice({
      id: "attached-1",
      name: "GitLab Server (10.0.0.64)",
      ip: "10.0.0.64",
    });
    mockStateStore.getDeviceById.mockReturnValue(attached);

    await expect(resolveDeviceByTarget(undefined, "attached-1")).resolves.toEqual(attached);
    expect(mockStateStore.getDeviceById).toHaveBeenCalledWith("attached-1");
  });
});
