import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  getDeviceById: vi.fn(),
  completeDeviceOnboarding: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getDeviceById: mocks.getDeviceById,
  },
}));

vi.mock("@/lib/adoption/orchestrator", () => ({
  completeDeviceOnboarding: mocks.completeDeviceOnboarding,
}));

import { POST as completeOnboarding } from "@/app/api/devices/[id]/onboarding/complete/route";

describe("onboarding completion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.getDeviceById.mockReturnValue({
      id: "device-1",
      name: "nas-01",
    });
  });

  it("completes onboarding with selected profiles and access methods", async () => {
    mocks.completeDeviceOnboarding.mockResolvedValue({
      deviceId: "device-1",
      run: {
        id: "run-1",
        status: "completed",
      },
    });

    const response = await completeOnboarding(
      new Request("http://localhost/api/devices/device-1/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: "Steward should manage backups and storage health.",
          selectedProfileIds: ["synology-dsm"],
          selectedAccessMethodKeys: ["https-dsm", "ssh-admin"],
          residualUnknowns: ["offsite replication target still missing"],
        }),
      }) as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run.status).toBe("completed");
    expect(mocks.completeDeviceOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "device-1",
        actor: "user",
        selectedProfileIds: ["synology-dsm"],
        selectedAccessMethodKeys: ["https-dsm", "ssh-admin"],
      }),
    );
  });

  it("rejects invalid onboarding payloads before calling the orchestrator", async () => {
    const response = await completeOnboarding(
      new Request("http://localhost/api/devices/device-1/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          residualUnknowns: [123],
        }),
      }) as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.completeDeviceOnboarding).not.toHaveBeenCalled();
  });

  it("returns 404 when the device no longer exists", async () => {
    mocks.getDeviceById.mockReturnValue(undefined);

    const response = await completeOnboarding(
      new Request("http://localhost/api/devices/missing/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }) as never,
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.completeDeviceOnboarding).not.toHaveBeenCalled();
  });
});
