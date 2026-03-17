import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveAction: vi.fn(),
  denyAction: vi.fn(),
  buildGlobalBriefing: vi.fn(),
  buildOperatorStatusText: vi.fn(),
  getGatewayBindingById: vi.fn(),
  getOrCreateGatewayThread: vi.fn(),
  getGatewayInboundEvent: vi.fn(),
  recordGatewayInboundEvent: vi.fn(),
  touchGatewayBindingActivity: vi.fn(),
  touchGatewayThreadActivity: vi.fn(),
  upsertGatewayBinding: vi.fn(),
  getGatewayThreadByExternalKey: vi.fn(),
  listMissions: vi.fn(),
  listSubagentsWithMetrics: vi.fn(),
  listInvestigations: vi.fn(),
  getSecret: vi.fn(),
  addAction: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@/lib/approvals/queue", () => ({
  approveAction: mocks.approveAction,
  denyAction: mocks.denyAction,
}));

vi.mock("@/lib/autonomy/briefings", () => ({
  buildGlobalBriefing: mocks.buildGlobalBriefing,
  buildOperatorStatusText: mocks.buildOperatorStatusText,
}));

vi.mock("@/lib/autonomy/store", () => ({
  autonomyStore: {
    getGatewayBindingById: mocks.getGatewayBindingById,
    getOrCreateGatewayThread: mocks.getOrCreateGatewayThread,
    getGatewayInboundEvent: mocks.getGatewayInboundEvent,
    recordGatewayInboundEvent: mocks.recordGatewayInboundEvent,
    touchGatewayBindingActivity: mocks.touchGatewayBindingActivity,
    touchGatewayThreadActivity: mocks.touchGatewayThreadActivity,
    upsertGatewayBinding: mocks.upsertGatewayBinding,
    getGatewayThreadByExternalKey: mocks.getGatewayThreadByExternalKey,
    listMissions: mocks.listMissions,
    listSubagentsWithMetrics: mocks.listSubagentsWithMetrics,
    listInvestigations: mocks.listInvestigations,
  },
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    getSecret: mocks.getSecret,
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    addAction: mocks.addAction,
    getState: mocks.getState,
  },
}));

import { handleTelegramWebhook, syncTelegramWebhook } from "@/lib/autonomy/gateway";

describe("telegram gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGatewayBindingById.mockReturnValue({
      id: "binding-1",
      kind: "telegram",
      name: "Telegram Ops",
      enabled: true,
      target: "",
      vaultSecretRef: "secret-ref",
      webhookSecret: "secret",
      defaultThreadTitle: "Ops",
      configJson: {},
      createdAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:00:00.000Z",
    });
    mocks.getOrCreateGatewayThread.mockReturnValue({
      id: "thread-1",
      bindingId: "binding-1",
      externalThreadKey: "1001:0",
      title: "Ops",
      createdAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:00:00.000Z",
    });
    mocks.getGatewayThreadByExternalKey.mockReturnValue({
      id: "thread-1",
    });
    mocks.getSecret.mockResolvedValue("123:token");
    mocks.buildOperatorStatusText.mockResolvedValue("Steward status");
    mocks.getState.mockResolvedValue({
      devices: [],
      incidents: [],
      recommendations: [],
    });
    mocks.addAction.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  });

  it("deduplicates repeated Telegram webhook updates", async () => {
    const fixturePath = path.join(process.cwd(), "tests", "fixtures", "autonomy", "telegram-update.json");
    const payload = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

    mocks.getGatewayInboundEvent
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({
        id: "event-1",
        bindingId: "binding-1",
        externalUpdateId: "424242",
        threadId: "thread-1",
        receivedAt: "2026-03-17T12:00:00.000Z",
      });

    const first = await handleTelegramWebhook(
      "binding-1",
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret",
        },
        body: JSON.stringify(payload),
      }),
    );
    const second = await handleTelegramWebhook(
      "binding-1",
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(first.ok).toBe(true);
    expect(second.ignored).toBe(true);
    expect(mocks.recordGatewayInboundEvent).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to deleteWebhook when polling mode is enabled", async () => {
    mocks.getGatewayBindingById.mockReturnValue({
      id: "binding-1",
      kind: "telegram",
      name: "Telegram Ops",
      enabled: true,
      target: "",
      vaultSecretRef: "secret-ref",
      webhookSecret: "secret",
      defaultThreadTitle: "Ops",
      configJson: {
        transportMode: "polling",
      },
      createdAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:00:00.000Z",
    });

    await syncTelegramWebhook("binding-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(mocks.getSecret.mock.calls.length)).toBe("1");
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("/deleteWebhook");
  });
});
