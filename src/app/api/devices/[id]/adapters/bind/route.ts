import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { getDeviceAdoptionSnapshot, startDeviceAdoption } from "@/lib/adoption/orchestrator";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const bindSchema = z.object({
  profileId: z.string().trim().min(1).optional(),
  profileIds: z.array(z.string().trim().min(1)).optional(),
  accessMethodKeys: z.array(z.string().trim().min(1)).optional(),
}).refine(
  (value) => Boolean(value.profileId || (value.profileIds && value.profileIds.length > 0) || (value.accessMethodKeys && value.accessMethodKeys.length > 0)),
  "Provide at least one profileId/profileIds or accessMethodKeys value.",
);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = bindSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const snapshot = await startDeviceAdoption(id, { triggeredBy: "user" });
  const profileIds = Array.from(new Set([
    ...(payload.data.profileIds ?? []),
    ...(payload.data.profileId ? [payload.data.profileId] : []),
  ]));

  if (profileIds.length > 0) {
    const available = new Set(snapshot.profiles.map((profile) => profile.profileId));
    const missing = profileIds.filter((profileId) => !available.has(profileId));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Unknown profile selection: ${missing.join(", ")}` }, { status: 404 });
    }
    stateStore.selectDeviceProfiles(id, profileIds);
  }

  if ((payload.data.accessMethodKeys ?? []).length > 0) {
    const available = new Set(snapshot.accessMethods.map((method) => method.key));
    const missing = payload.data.accessMethodKeys!.filter((key) => !available.has(key));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Unknown access method selection: ${missing.join(", ")}` }, { status: 404 });
    }
    stateStore.selectAccessMethods(id, payload.data.accessMethodKeys!);
  }

  const nextSnapshot = await getDeviceAdoptionSnapshot(id);

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated onboarding selection for ${device.name}`,
    context: {
      deviceId: id,
      profileIds,
      accessMethodKeys: payload.data.accessMethodKeys ?? [],
    },
  });

  return NextResponse.json(nextSnapshot);
}
