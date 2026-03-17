import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  getPolicyRules: vi.fn(),
  upsertPolicyRule: vi.fn(),
  deletePolicyRule: vi.fn(),
  getMaintenanceWindows: vi.fn(),
  upsertMaintenanceWindow: vi.fn(),
  deleteMaintenanceWindow: vi.fn(),
  addAction: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getPolicyRules: mocks.getPolicyRules,
    upsertPolicyRule: mocks.upsertPolicyRule,
    deletePolicyRule: mocks.deletePolicyRule,
    getMaintenanceWindows: mocks.getMaintenanceWindows,
    upsertMaintenanceWindow: mocks.upsertMaintenanceWindow,
    deleteMaintenanceWindow: mocks.deleteMaintenanceWindow,
    addAction: mocks.addAction,
  },
}));

import { POST as createMaintenanceWindow } from "@/app/api/maintenance-windows/route";
import { DELETE as deleteMaintenanceWindowRoute, PATCH as updateMaintenanceWindow } from "@/app/api/maintenance-windows/[id]/route";
import { POST as createPolicy } from "@/app/api/policies/route";
import { DELETE as deletePolicy, PATCH as updatePolicy } from "@/app/api/policies/[id]/route";

describe("policy and maintenance-window routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.addAction.mockResolvedValue(undefined);
  });

  it("creates a policy rule", async () => {
    const response = await createPolicy(
      new Request("http://localhost/api/policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Require approval in prod",
          description: "Gate higher-risk production actions.",
          decision: "REQUIRE_APPROVAL",
          priority: 25,
          enabled: true,
          actionClasses: ["C", "D"],
          autonomyTiers: [2, 3],
          environmentLabels: ["prod"],
          deviceTypes: ["server", "nas"],
        }),
      }) as never,
    );

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.name).toBe("Require approval in prod");
    expect(mocks.upsertPolicyRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Require approval in prod",
        decision: "REQUIRE_APPROVAL",
        priority: 25,
      }),
    );
    expect(mocks.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "policy",
        message: expect.stringContaining("Created policy rule"),
      }),
    );
  });

  it("updates and deletes a policy rule", async () => {
    mocks.getPolicyRules.mockReturnValue([
      {
        id: "policy-1",
        name: "Original",
        description: "",
        decision: "ALLOW_AUTO",
        priority: 100,
        enabled: true,
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      },
    ]);

    const patchResponse = await updatePolicy(
      new Request("http://localhost/api/policies/policy-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: false,
          decision: "DENY",
        }),
      }) as never,
      { params: Promise.resolve({ id: "policy-1" }) },
    );

    const patchBody = await patchResponse.json();

    expect(patchResponse.status).toBe(200);
    expect(patchBody.enabled).toBe(false);
    expect(patchBody.decision).toBe("DENY");
    expect(mocks.upsertPolicyRule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "policy-1",
        enabled: false,
        decision: "DENY",
        updatedAt: expect.any(String),
      }),
    );

    const deleteResponse = await deletePolicy(
      new Request("http://localhost/api/policies/policy-1", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: "policy-1" }) },
    );

    expect(deleteResponse.status).toBe(200);
    expect(mocks.deletePolicyRule).toHaveBeenCalledWith("policy-1");
    expect(mocks.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Deleted policy rule: policy-1",
      }),
    );
  });

  it("creates, updates, and deletes a maintenance window", async () => {
    const createResponse = await createMaintenanceWindow(
      new Request("http://localhost/api/maintenance-windows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Weekend patching",
          deviceIds: ["device-1", "device-2"],
          cronStart: "0 2 * * 6",
          durationMinutes: 180,
          enabled: true,
        }),
      }) as never,
    );

    const createBody = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(createBody.name).toBe("Weekend patching");
    expect(mocks.upsertMaintenanceWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Weekend patching",
        cronStart: "0 2 * * 6",
        durationMinutes: 180,
      }),
    );

    mocks.getMaintenanceWindows.mockReturnValue([
      {
        id: "window-1",
        name: "Weekend patching",
        deviceIds: ["device-1"],
        cronStart: "0 2 * * 6",
        durationMinutes: 180,
        enabled: true,
        createdAt: "2026-03-16T00:00:00.000Z",
      },
    ]);

    const patchResponse = await updateMaintenanceWindow(
      new Request("http://localhost/api/maintenance-windows/window-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: false,
          durationMinutes: 240,
        }),
      }) as never,
      { params: Promise.resolve({ id: "window-1" }) },
    );

    const patchBody = await patchResponse.json();

    expect(patchResponse.status).toBe(200);
    expect(patchBody.enabled).toBe(false);
    expect(patchBody.durationMinutes).toBe(240);
    expect(mocks.upsertMaintenanceWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "window-1",
        enabled: false,
        durationMinutes: 240,
      }),
    );

    const deleteResponse = await deleteMaintenanceWindowRoute(
      new Request("http://localhost/api/maintenance-windows/window-1", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: "window-1" }) },
    );

    expect(deleteResponse.status).toBe(200);
    expect(mocks.deleteMaintenanceWindow).toHaveBeenCalledWith("window-1");
  });
});
