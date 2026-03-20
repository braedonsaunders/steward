import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Device } from "@/lib/state/types";

const mocks = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  buildLanguageModelMock: vi.fn(),
  getDeviceWidgetsMock: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateObject: mocks.generateObjectMock,
  };
});

vi.mock("@/lib/llm/providers", () => ({
  buildLanguageModel: mocks.buildLanguageModelMock,
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getDeviceWidgets: mocks.getDeviceWidgetsMock,
  },
}));

import { planWidgetRoute } from "@/lib/assistant/widget-routing";

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
    createdAt: "2026-03-18T19:00:00.000Z",
  };
}

describe("widget routing", () => {
  beforeEach(() => {
    mocks.generateObjectMock.mockReset();
    mocks.buildLanguageModelMock.mockReset();
    mocks.getDeviceWidgetsMock.mockReset();
    mocks.buildLanguageModelMock.mockResolvedValue({} as never);
    mocks.getDeviceWidgetsMock.mockReturnValue([]);
  });

  it("lets the model decline web interface language that is not widget work", async () => {
    mocks.generateObjectMock.mockResolvedValue({
      object: {
        route: "none",
        reason: "This is a device web UI and upgrade request, not widget work.",
      },
    });

    const history = [
      assistantMessage("The API requires authentication. Let me check the version through the web interface and then review the update guidance."),
    ];

    const plan = await planWidgetRoute({
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history,
      userInput: "yes its ok for it to be offline, upgrade all 10, create backup",
    });

    expect(plan).toEqual({
      route: "none",
      reason: "This is a device web UI and upgrade request, not widget work.",
    });
    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
    expect(String(mocks.generateObjectMock.mock.calls[0]?.[0]?.prompt ?? "")).toContain("Current user message: yes its ok for it to be offline, upgrade all 10, create backup");
  });

  it("lets the model continue explicit widget follow-ups", async () => {
    mocks.getDeviceWidgetsMock.mockReturnValue([
      {
        id: "widget-1",
        deviceId: "device-1",
        slug: "status-panel",
        name: "Status Panel",
        description: "Current device status",
        html: "<div></div>",
        css: "",
        js: "",
        capabilities: ["context"],
        controls: [],
        revision: 3,
        updatedAt: "2026-03-18T19:00:00.000Z",
        createdAt: "2026-03-18T18:00:00.000Z",
      },
    ]);

    mocks.generateObjectMock.mockResolvedValue({
      object: {
        route: "widget",
        reason: "The user is explicitly asking to revise the existing widget.",
        toolArgs: {
          action: "generate",
          widget_id: "widget-1",
          prompt: "Revise the existing status panel widget for this device.",
        },
      },
    });

    const history = [
      assistantMessage("I can update the widget for this device. Do you want me to revise it?"),
    ];

    const plan = await planWidgetRoute({
      provider: "anthropic",
      attachedDevice: buildDevice(),
      history,
      userInput: "yes, update it",
    });

    expect(plan).toEqual({
      route: "widget",
      reason: "The user is explicitly asking to revise the existing widget.",
      toolArgs: {
        action: "generate",
        widget_id: "widget-1",
        prompt: "Revise the existing status panel widget for this device.",
      },
    });
    expect(mocks.generateObjectMock).toHaveBeenCalledTimes(1);
  });
});
