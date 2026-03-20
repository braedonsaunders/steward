import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Device } from "@/lib/state/types";

const mocks = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  generateTextMock: vi.fn(),
  buildLanguageModelMock: vi.fn(),
  getRecentActionsMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: mocks.generateObjectMock,
    generateText: mocks.generateTextMock,
  };
});

vi.mock("@/lib/llm/providers", () => ({
  buildLanguageModel: mocks.buildLanguageModelMock,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getDataDir: vi.fn(() => ".steward"),
    getRecentActions: mocks.getRecentActionsMock,
    getPlaybookRunById: vi.fn(() => null),
  },
}));

import { tryHandleDeviceChatAction } from "@/lib/assistant/device-actions";

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "device-1",
    name: "GitLab Server",
    ip: "10.0.0.64",
    type: "container-host",
    status: "online",
    autonomyTier: 1,
    environmentLabel: "lab",
    tags: [],
    protocols: ["ssh", "http-api"],
    services: [],
    firstSeenAt: "2026-03-19T09:00:00.000Z",
    lastSeenAt: "2026-03-19T09:00:00.000Z",
    lastChangedAt: "2026-03-19T09:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function assistantMessage(content: string): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: "session-1",
    role: "assistant",
    content,
    provider: "anthropic",
    error: false,
    createdAt: "2026-03-19T09:41:00.000Z",
  };
}

describe("device chat actions", () => {
  beforeEach(() => {
    mocks.generateObjectMock.mockReset();
    mocks.generateTextMock.mockReset();
    mocks.buildLanguageModelMock.mockReset();
    mocks.getRecentActionsMock.mockReset();
    mocks.buildLanguageModelMock.mockResolvedValue({} as never);
    mocks.getRecentActionsMock.mockReturnValue([]);
  });

  it("keeps upgrade-path research in the normal chat flow", async () => {
    mocks.generateObjectMock.mockResolvedValue({
      object: {
        intent: "none",
        rationale: "The user is asking for research and intermediary upgrade steps, not asking Steward to execute.",
        approvalDecision: null,
        deviceSettings: {
          renameRequested: false,
          categoryRequested: false,
          suggestedName: null,
          suggestedType: null,
        },
      },
    });

    const result = await tryHandleDeviceChatAction({
      input: "do research and find all the intermediary steps required",
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history: [
        assistantMessage("GitLab 16.11.10 is the installed version."),
        assistantMessage("Would you like me to create a job when you're ready, or just research the upgrade path?"),
      ],
    });

    expect(result).toEqual({ handled: false });
    expect(mocks.buildLanguageModelMock).toHaveBeenCalledTimes(1);
    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(2);
  });
});
