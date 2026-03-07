import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { startDeviceAdoption } from "@/lib/adoption/orchestrator";
import { getDeviceNameValidationError, normalizeDeviceName } from "@/lib/devices/naming";
import { getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import { DEVICE_TYPE_VALUES } from "@/lib/state/types";

export const runtime = "nodejs";

const ADOPTION_RECOMMENDATION_TITLE = /adopt\s+.+\s+for\s+active\s+management/i;

const updateDeviceSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  type: z.enum(DEVICE_TYPE_VALUES).optional(),
  autonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  tags: z.array(z.string().min(1)).optional(),
  adoptionStatus: z.enum(["discovered", "adopted", "ignored"]).optional(),
  operatorNotes: z.string().trim().max(4000).nullable().optional(),
  operatorMemoryJson: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const state = await stateStore.getState();

  const device = state.devices.find((d) => d.id === id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const baseline = state.baselines.find((b) => b.deviceId === id) ?? null;
  const incidents = state.incidents.filter((i) => i.deviceIds.includes(id));
  const recommendations = state.recommendations.filter((r) =>
    r.relatedDeviceIds.includes(id),
  );

  const graphNodeId = `device:${id}`;
  const edges = state.graph.edges.filter(
    (e) => e.from === graphNodeId || e.to === graphNodeId,
  );

  return NextResponse.json({
    device,
    baseline,
    incidents,
    recommendations,
    edges,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = updateDeviceSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json(
      { error: payload.error.flatten() },
      { status: 400 },
    );
  }

  const state = await stateStore.getState();
  const device = state.devices.find((d) => d.id === id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {};

  if (payload.data.name !== undefined) {
    if (getDeviceAdoptionStatus(device) !== "adopted") {
      return NextResponse.json(
        { error: "Only adopted devices can be renamed" },
        { status: 403 },
      );
    }
    const normalizedName = normalizeDeviceName(payload.data.name);
    const nameValidationError = getDeviceNameValidationError(normalizedName);
    if (nameValidationError) {
      return NextResponse.json(
        { error: `Invalid device name '${normalizedName}'. ${nameValidationError}` },
        { status: 400 },
      );
    }

    device.name = normalizedName;
    const identity =
      typeof device.metadata.identity === "object" && device.metadata.identity !== null
        ? (device.metadata.identity as Record<string, unknown>)
        : {};
    device.metadata = {
      ...device.metadata,
      identity: {
        ...identity,
        nameManuallySet: true,
        nameManuallySetAt: new Date().toISOString(),
        nameSetBy: "user",
      },
    };
    updates.name = normalizedName;
  }

  if (payload.data.autonomyTier !== undefined) {
    device.autonomyTier = payload.data.autonomyTier;
    updates.autonomyTier = payload.data.autonomyTier;
  }

  if (payload.data.tags !== undefined) {
    device.tags = payload.data.tags;
    updates.tags = payload.data.tags;
  }

  if (payload.data.adoptionStatus !== undefined) {
    const previousStatus = getDeviceAdoptionStatus(device);
    const existingAdoption =
      typeof device.metadata.adoption === "object" && device.metadata.adoption !== null
        ? (device.metadata.adoption as Record<string, unknown>)
        : {};
    device.metadata = {
      ...device.metadata,
      adoption: {
        ...existingAdoption,
        status: payload.data.adoptionStatus,
      },
    };
    updates.adoptionStatus = payload.data.adoptionStatus;

    if (previousStatus !== "adopted" && payload.data.adoptionStatus === "adopted") {
      updates.adoptionOnboarding = "requested";

      const latestState = await stateStore.getState();
      const filteredRecommendations = latestState.recommendations.filter((recommendation) => {
        const matchesDevice = recommendation.relatedDeviceIds.includes(device.id);
        return !(matchesDevice && ADOPTION_RECOMMENDATION_TITLE.test(recommendation.title));
      });
      if (filteredRecommendations.length !== latestState.recommendations.length) {
        await stateStore.setRecommendations(filteredRecommendations);
        updates.adoptionRecommendationsRemoved = latestState.recommendations.length - filteredRecommendations.length;
      }
    }
  }

  if (payload.data.operatorNotes !== undefined) {
    const existingNotes =
      typeof device.metadata.notes === "object" && device.metadata.notes !== null
        ? (device.metadata.notes as Record<string, unknown>)
        : {};
    device.metadata = {
      ...device.metadata,
      notes: {
        ...existingNotes,
        operatorContext: payload.data.operatorNotes,
      },
    };
    updates.operatorNotes = payload.data.operatorNotes;
  }

  if (payload.data.operatorMemoryJson !== undefined) {
    const existingNotes =
      typeof device.metadata.notes === "object" && device.metadata.notes !== null
        ? (device.metadata.notes as Record<string, unknown>)
        : {};
    device.metadata = {
      ...device.metadata,
      notes: {
        ...existingNotes,
        structuredContext: payload.data.operatorMemoryJson,
        structuredContextUpdatedAt: new Date().toISOString(),
      },
    };
    updates.operatorMemoryJson = payload.data.operatorMemoryJson;
  }

  if (payload.data.type !== undefined) {
    device.type = payload.data.type;
    updates.type = payload.data.type;
  }

  device.lastChangedAt = new Date().toISOString();

  await stateStore.upsertDevice(device);

  const changedFields = Object.keys(updates).join(", ");
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Device updated: ${device.name} (${changedFields})`,
    context: {
      deviceId: device.id,
      updates,
    },
  });

  if (updates.adoptionOnboarding === "requested") {
    try {
      await startDeviceAdoption(device.id, { triggeredBy: "user" });
    } catch (error) {
      await stateStore.addAction({
        actor: "steward",
        kind: "diagnose",
        message: `Failed to start adoption workflow for ${device.name}`,
        context: {
          deviceId: device.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return NextResponse.json({ device });
}
