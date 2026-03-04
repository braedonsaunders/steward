import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const updateDeviceSchema = z.object({
  autonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  tags: z.array(z.string().min(1)).optional(),
  adoptionStatus: z.enum(["discovered", "adopted", "ignored"]).optional(),
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

  if (payload.data.autonomyTier !== undefined) {
    device.autonomyTier = payload.data.autonomyTier;
    updates.autonomyTier = payload.data.autonomyTier;
  }

  if (payload.data.tags !== undefined) {
    device.tags = payload.data.tags;
    updates.tags = payload.data.tags;
  }

  if (payload.data.adoptionStatus !== undefined) {
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

  return NextResponse.json({ device });
}
