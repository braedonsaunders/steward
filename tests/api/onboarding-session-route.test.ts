import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  ensureOnboardingSession: vi.fn(),
  getOnboardingSession: vi.fn(),
  getDeviceAdoptionSnapshot: vi.fn(),
  getDeviceById: vi.fn(),
  getChatMessages: vi.fn(),
  deleteChatSession: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/adoption/conversation", () => ({
  ensureOnboardingSession: mocks.ensureOnboardingSession,
  getOnboardingSession: mocks.getOnboardingSession,
}));

vi.mock("@/lib/adoption/orchestrator", () => ({
  getDeviceAdoptionSnapshot: mocks.getDeviceAdoptionSnapshot,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getDeviceById: mocks.getDeviceById,
    getChatMessages: mocks.getChatMessages,
    deleteChatSession: mocks.deleteChatSession,
  },
}));

import { POST as getOrCreateOnboardingSession } from "@/app/api/devices/[id]/onboarding/session/route";

describe("onboarding session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.getDeviceById.mockReturnValue({
      id: "device-1",
      name: "wistron-infocomm-server-10-0-1-148",
    });
    mocks.getDeviceAdoptionSnapshot.mockResolvedValue({
      run: null,
      unresolvedRequiredQuestions: [],
      credentials: [],
      accessMethods: [],
      profiles: [],
      draft: null,
      accessSurfaces: [],
      workloads: [],
      assurances: [],
      assuranceRuns: [],
      bindings: [],
      serviceContracts: [],
    });
  });

  it("recreates onboarding sessions that only contain the legacy generic error seed", async () => {
    mocks.ensureOnboardingSession
      .mockReturnValueOnce({
        id: "broken-session",
        title: "[Onboarding] broken",
      })
      .mockReturnValueOnce({
        id: "fresh-session",
        title: "[Onboarding] fresh",
      });
    mocks.getChatMessages
      .mockReturnValueOnce([
        {
          id: "msg-1",
          role: "assistant",
          content: "Error",
          error: true,
        },
      ])
      .mockReturnValueOnce([]);

    const response = await getOrCreateOnboardingSession(
      new Request("http://localhost/api/devices/device-1/onboarding/session", {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.deleteChatSession).toHaveBeenCalledWith("broken-session");
    expect(mocks.ensureOnboardingSession).toHaveBeenCalledTimes(2);
    expect(body.session.id).toBe("fresh-session");
    expect(body.messages).toEqual([]);
  });

  it("recreates onboarding sessions that only contain the SDK generic error seed", async () => {
    mocks.ensureOnboardingSession
      .mockReturnValueOnce({
        id: "broken-session",
        title: "[Onboarding] broken",
      })
      .mockReturnValueOnce({
        id: "fresh-session",
        title: "[Onboarding] fresh",
      });
    mocks.getChatMessages
      .mockReturnValueOnce([
        {
          id: "msg-1",
          role: "assistant",
          content: "Failed to process error response",
          error: true,
        },
      ])
      .mockReturnValueOnce([]);

    const response = await getOrCreateOnboardingSession(
      new Request("http://localhost/api/devices/device-1/onboarding/session", {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.deleteChatSession).toHaveBeenCalledWith("broken-session");
    expect(body.session.id).toBe("fresh-session");
    expect(body.messages).toEqual([]);
  });

  it("recreates onboarding sessions that only contain a provider error type label", async () => {
    mocks.ensureOnboardingSession
      .mockReturnValueOnce({
        id: "broken-session",
        title: "[Onboarding] broken",
      })
      .mockReturnValueOnce({
        id: "fresh-session",
        title: "[Onboarding] fresh",
      });
    mocks.getChatMessages
      .mockReturnValueOnce([
        {
          id: "msg-1",
          role: "assistant",
          content: "invalid_request_error",
          error: true,
        },
      ])
      .mockReturnValueOnce([]);

    const response = await getOrCreateOnboardingSession(
      new Request("http://localhost/api/devices/device-1/onboarding/session", {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ id: "device-1" }) },
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.deleteChatSession).toHaveBeenCalledWith("broken-session");
    expect(body.session.id).toBe("fresh-session");
    expect(body.messages).toEqual([]);
  });
});
