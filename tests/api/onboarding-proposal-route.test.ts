import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  getOnboardingSession: vi.fn(),
  synthesizeOnboardingModel: vi.fn(),
  completeDeviceOnboarding: vi.fn(),
  getDeviceAdoptionSnapshot: vi.fn(),
  getLatestAdoptionRun: vi.fn(),
  upsertAdoptionRun: vi.fn(),
  getDeviceById: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/adoption/conversation", () => ({
  getOnboardingSession: mocks.getOnboardingSession,
  synthesizeOnboardingModel: mocks.synthesizeOnboardingModel,
}));

vi.mock("@/lib/adoption/orchestrator", () => ({
  completeDeviceOnboarding: mocks.completeDeviceOnboarding,
  getDeviceAdoptionSnapshot: mocks.getDeviceAdoptionSnapshot,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getLatestAdoptionRun: mocks.getLatestAdoptionRun,
    upsertAdoptionRun: mocks.upsertAdoptionRun,
    getDeviceById: mocks.getDeviceById,
  },
}));

import { GET as getOnboardingProposal } from "@/app/api/devices/[id]/onboarding/proposal/route";

describe("onboarding proposal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.getDeviceById.mockReturnValue({
      id: "device-1",
      name: "GitLab Server (10.0.0.64)",
      ip: "10.0.0.64",
    });
  });

  it("falls back to stored synthesis when live generation fails", async () => {
    mocks.getOnboardingSession.mockReturnValue({ id: "session-1" });
    mocks.synthesizeOnboardingModel.mockRejectedValue(
      new Error("Anthropic OAuth session refresh failed: invalid_grant"),
    );
    mocks.getLatestAdoptionRun.mockReturnValue({
      id: "run-1",
      deviceId: "device-1",
      profileJson: {
        onboardingSynthesis: {
          summary: "Stored synthesis",
          responsibilities: [],
          credentialRequests: [],
          assurances: [],
          contracts: [],
          nextActions: [],
        },
      },
    });

    const response = await getOnboardingProposal(
      new Request("http://localhost/api/devices/device-1/onboarding/proposal?refresh=1") as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.source).toBe("stored");
    expect(body.synthesis?.summary).toBe("Stored synthesis");
    expect(body.warning).toContain("Anthropic OAuth session refresh failed");
  });
});
