import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "@/lib/state/types";

const { mockStateStore, mockVault } = vi.hoisted(() => ({
  mockStateStore: {
    getDeviceById: vi.fn(),
    getDeviceCredentials: vi.fn(),
    upsertDeviceCredential: vi.fn(),
    addAction: vi.fn(),
  },
  mockVault: {
    ensureUnlocked: vi.fn(),
    setSecret: vi.fn(),
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: mockStateStore,
}));

vi.mock("@/lib/security/vault", () => ({
  vault: mockVault,
}));

import { storeDeviceCredential } from "@/lib/adoption/credentials";

describe("storeDeviceCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStateStore.getDeviceById.mockReturnValue({
      id: "device-1",
      name: "GitLab Server",
    });
    mockVault.ensureUnlocked.mockResolvedValue(true);
    mockVault.setSecret.mockResolvedValue(undefined);
    mockStateStore.upsertDeviceCredential.mockImplementation((credential: DeviceCredential) => credential);
    mockStateStore.addAction.mockResolvedValue(undefined);
  });

  it("does not overwrite a stored SSH credential when the account label changes", async () => {
    mockStateStore.getDeviceCredentials.mockReturnValue([
      {
        id: "cred-admin",
        deviceId: "device-1",
        protocol: "ssh",
        vaultSecretRef: "device.device-1.credential.cred-admin",
        accountLabel: "administrator",
        scopeJson: { level: "admin" },
        status: "provided",
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-18T00:00:00.000Z",
      } satisfies DeviceCredential,
    ]);

    const stored = await storeDeviceCredential({
      deviceId: "device-1",
      protocol: "ssh",
      secret: "new-secret",
      accountLabel: "root",
    });

    expect(stored.id).not.toBe("cred-admin");
    expect(stored.vaultSecretRef).not.toBe("device.device-1.credential.cred-admin");
    expect(stored.accountLabel).toBe("root");
    expect(mockVault.setSecret).toHaveBeenCalledWith(stored.vaultSecretRef, "new-secret");
  });

  it("reuses the stored credential record when the account label matches", async () => {
    mockStateStore.getDeviceCredentials.mockReturnValue([
      {
        id: "cred-admin",
        deviceId: "device-1",
        protocol: "ssh",
        vaultSecretRef: "device.device-1.credential.cred-admin",
        accountLabel: "administrator",
        scopeJson: { level: "admin" },
        status: "provided",
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-18T00:00:00.000Z",
      } satisfies DeviceCredential,
    ]);

    const stored = await storeDeviceCredential({
      deviceId: "device-1",
      protocol: "ssh",
      secret: "replacement-secret",
      accountLabel: "administrator",
    });

    expect(stored.id).toBe("cred-admin");
    expect(stored.vaultSecretRef).toBe("device.device-1.credential.cred-admin");
    expect(mockVault.setSecret).toHaveBeenCalledWith("device.device-1.credential.cred-admin", "replacement-secret");
  });
});
