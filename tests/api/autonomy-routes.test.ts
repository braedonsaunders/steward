import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  listPacks: vi.fn(),
  listPackSummaries: vi.fn(),
  listMissions: vi.fn(),
  getMissionWithDetails: vi.fn(),
  upsertMission: vi.fn(),
  getMissionById: vi.fn(),
  getPackById: vi.fn(),
  listPackResources: vi.fn(),
  listPackVersions: vi.fn(),
  uninstallPack: vi.fn(),
  listSigners: vi.fn(),
  getSignerById: vi.fn(),
  getSignerBySlug: vi.fn(),
  upsertSigner: vi.fn(),
  deleteSigner: vi.fn(),
  createManagedPack: vi.fn(),
  updateManagedPack: vi.fn(),
  buildPackDetail: vi.fn(),
  addAction: vi.fn(),
  enqueueMissionJob: vi.fn(),
  enqueueBriefingCompilationJob: vi.fn(),
  listGatewayBindings: vi.fn(),
  upsertGatewayBinding: vi.fn(),
  syncTelegramWebhook: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock("@/lib/auth/guard", () => ({
  isAuthorized: mocks.isAuthorized,
}));

vi.mock("@/lib/autonomy/store", () => ({
  autonomyStore: {
    listPacks: mocks.listPacks,
    listMissions: mocks.listMissions,
    getMissionWithDetails: mocks.getMissionWithDetails,
    upsertMission: mocks.upsertMission,
    getMissionById: mocks.getMissionById,
    listGatewayBindings: mocks.listGatewayBindings,
    upsertGatewayBinding: mocks.upsertGatewayBinding,
  },
}));

vi.mock("@/lib/packs/repository", () => ({
  packRepository: {
    list: mocks.listPacks,
    listSummaries: mocks.listPackSummaries,
    getById: mocks.getPackById,
    listResources: mocks.listPackResources,
    listVersions: mocks.listPackVersions,
    uninstall: mocks.uninstallPack,
    listSigners: mocks.listSigners,
    getSignerById: mocks.getSignerById,
    getSignerBySlug: mocks.getSignerBySlug,
    upsertSigner: mocks.upsertSigner,
    deleteSigner: mocks.deleteSigner,
  },
}));

vi.mock("@/lib/packs/service", () => ({
  createManagedPack: mocks.createManagedPack,
  updateManagedPack: mocks.updateManagedPack,
  buildPackDetail: mocks.buildPackDetail,
}));

vi.mock("@/lib/autonomy/runtime", () => ({
  enqueueMissionJob: mocks.enqueueMissionJob,
  enqueueBriefingCompilationJob: mocks.enqueueBriefingCompilationJob,
}));

vi.mock("@/lib/autonomy/gateway", () => ({
  syncTelegramWebhook: mocks.syncTelegramWebhook,
}));

vi.mock("@/lib/security/vault", () => ({
  vault: {
    setSecret: mocks.setSecret,
  },
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    addAction: mocks.addAction,
  },
}));

import { POST as createMission, GET as listMissions } from "@/app/api/missions/route";
import { POST as runMission } from "@/app/api/missions/[id]/run/route";
import { POST as queueBriefing } from "@/app/api/briefings/route";
import { POST as createBinding } from "@/app/api/gateway/bindings/route";
import { POST as createPack } from "@/app/api/packs/route";
import { PATCH as updatePack, DELETE as removePack } from "@/app/api/packs/[id]/route";
import { POST as createSigner } from "@/app/api/packs/signers/route";

describe("autonomy routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAuthorized.mockReturnValue(true);
    mocks.addAction.mockResolvedValue(undefined);
    mocks.listMissions.mockReturnValue([]);
    mocks.listPacks.mockReturnValue([]);
    mocks.listPackSummaries.mockReturnValue([]);
    mocks.listPackResources.mockReturnValue([]);
    mocks.listPackVersions.mockReturnValue([]);
    mocks.listSigners.mockReturnValue([]);
    mocks.buildPackDetail.mockImplementation((pack: unknown) => ({ pack, resources: [], versions: [] }));
  });

  it("creates and lists missions", async () => {
    mocks.getMissionWithDetails.mockReturnValue({
      id: "mission-1",
      title: "Backup Hygiene",
      summary: "Own backup freshness.",
      kind: "backup-guardian",
      status: "active",
      priority: "high",
      cadenceMinutes: 60,
      openInvestigations: [],
    });

    const createResponse = await createMission(
      new Request("http://localhost/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Backup Hygiene",
          summary: "Own backup freshness.",
          kind: "backup-guardian",
          priority: "high",
          cadenceMinutes: 60,
        }),
      }) as never,
    );

    expect(createResponse.status).toBe(201);
    expect(mocks.upsertMission).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Backup Hygiene",
        kind: "backup-guardian",
        priority: "high",
      }),
    );

    mocks.listMissions.mockReturnValue([
      {
        id: "mission-1",
      },
    ]);

    const listResponse = await listMissions(
      new Request("http://localhost/api/missions", {
        method: "GET",
      }) as never,
    );
    const listBody = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(listBody.missions).toHaveLength(1);
  });

  it("queues mission runs and briefing compilation", async () => {
    mocks.getMissionById.mockReturnValue({
      id: "mission-1",
      title: "Availability Overwatch",
    });

    const runResponse = await runMission(
      new Request("http://localhost/api/missions/mission-1/run", {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ id: "mission-1" }) },
    );

    expect(runResponse.status).toBe(202);
    expect(mocks.enqueueMissionJob).toHaveBeenCalledWith("mission-1");

    const briefingResponse = await queueBriefing(
      new Request("http://localhost/api/briefings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          missionId: "mission-1",
        }),
      }) as never,
    );

    expect(briefingResponse.status).toBe(202);
    expect(mocks.enqueueBriefingCompilationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        reason: "manual",
      }),
    );
  });

  it("creates gateway bindings and stores the Telegram token", async () => {
    const response = await createBinding(
      new Request("http://localhost/api/gateway/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Telegram Ops",
          botToken: "123:abc",
          webhookUrl: "https://example.com/api/gateway/telegram/test/webhook",
          webhookSecret: "secret",
        }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(mocks.setSecret).toHaveBeenCalledWith(
      expect.stringContaining("gateway.telegram."),
      "123:abc",
    );
    expect(mocks.upsertGatewayBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Telegram Ops",
        kind: "telegram",
      }),
    );
    expect(mocks.syncTelegramWebhook).toHaveBeenCalled();
  });

  it("installs, updates, and removes managed packs", async () => {
    mocks.createManagedPack.mockReturnValue({
      id: "pack.managed.test",
      slug: "managed-test",
      name: "Managed Test",
      version: "1.0.0",
      description: "Managed pack",
      kind: "managed",
      enabled: true,
      builtin: false,
      trustMode: "verified",
      signerId: "signer-1",
      signature: "abc",
      signatureAlgorithm: "ed25519",
      verificationStatus: "verified",
      verifiedAt: "2026-03-17T12:00:00.000Z",
      manifestJson: {
        slug: "managed-test",
        name: "Managed Test",
        version: "1.0.0",
        description: "Managed pack",
        resources: [{ type: "mission-template", key: "mission-x", title: "Mission X" }],
      },
      installedAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:00:00.000Z",
    });
    mocks.getPackById.mockReturnValue({
      id: "pack.managed.test",
      slug: "managed-test",
      name: "Managed Test",
      version: "1.0.0",
      description: "Managed pack",
      kind: "managed",
      enabled: true,
      builtin: false,
      trustMode: "unsigned",
      verificationStatus: "unsigned",
      manifestJson: {
        slug: "managed-test",
        name: "Managed Test",
        version: "1.0.0",
        description: "Managed pack",
        resources: [{ type: "mission-template", key: "mission-x", title: "Mission X" }],
      },
      installedAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:00:00.000Z",
    });
    mocks.updateManagedPack.mockImplementation((pack: Record<string, unknown>) => ({
      ...pack,
      version: "1.1.0",
      manifestJson: {
        slug: "managed-test",
        name: "Managed Test",
        version: "1.1.0",
        description: "Managed pack",
        resources: [{ type: "mission-template", key: "mission-x", title: "Mission X" }],
      },
    }));
    mocks.uninstallPack.mockReturnValue({
      id: "pack.managed.test",
      slug: "managed-test",
      name: "Managed Test",
      version: "1.1.0",
      description: "Managed pack",
      kind: "managed",
      enabled: false,
      builtin: false,
      trustMode: "unsigned",
      verificationStatus: "unsigned",
      manifestJson: {
        slug: "managed-test",
        name: "Managed Test",
        version: "1.1.0",
        description: "Managed pack",
        resources: [{ type: "mission-template", key: "mission-x", title: "Mission X" }],
      },
      installedAt: "2026-03-17T12:00:00.000Z",
      updatedAt: "2026-03-17T12:10:00.000Z",
    });

    const manifest = {
      slug: "managed-test",
      name: "Managed Test",
      version: "1.0.0",
      description: "Managed pack",
      resources: [{ type: "mission-template", key: "mission-x", title: "Mission X" }],
    };

    const createResponse = await createPack(
      new Request("http://localhost/api/packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trustMode: "verified",
          signerId: "signer-1",
          signature: "abc",
          manifest,
        }),
      }) as never,
    );
    expect(createResponse.status).toBe(201);
    expect(mocks.createManagedPack).toHaveBeenCalledWith(expect.objectContaining({
      trustMode: "verified",
      signerId: "signer-1",
    }));

    const updateResponse = await updatePack(
      new Request("http://localhost/api/packs/pack.managed.test", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signerId: "signer-1",
          signature: "def",
          manifest: {
            ...manifest,
            version: "1.1.0",
          },
        }),
      }) as never,
      { params: Promise.resolve({ id: "pack.managed.test" }) },
    );
    expect(updateResponse.status).toBe(200);
    expect(mocks.updateManagedPack).toHaveBeenCalled();

    const deleteResponse = await removePack(
      new Request("http://localhost/api/packs/pack.managed.test", {
        method: "DELETE",
      }) as never,
      { params: Promise.resolve({ id: "pack.managed.test" }) },
    );
    expect(deleteResponse.status).toBe(200);
    expect(mocks.uninstallPack).toHaveBeenCalledWith("pack.managed.test");
  });

  it("registers pack signers", async () => {
    mocks.getSignerBySlug.mockReturnValue(undefined);
    mocks.upsertSigner.mockImplementation((signer: unknown) => signer);

    const response = await createSigner(
      new Request("http://localhost/api/packs/signers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: "trusted-lab",
          name: "Trusted Lab",
          publicKeyPem: "-----BEGIN PUBLIC KEY-----\\nZmFrZQ==\\n-----END PUBLIC KEY-----",
        }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(mocks.upsertSigner).toHaveBeenCalledWith(expect.objectContaining({
      slug: "trusted-lab",
      algorithm: "ed25519",
    }));
  });
});
