import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const bindSchema = z.object({
  adapterId: z.string().trim().min(1),
  protocol: z.string().trim().min(1),
});

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

  const bindings = stateStore.getDeviceAdapterBindings(id);
  const target = bindings.find(
    (binding) => binding.adapterId === payload.data.adapterId && binding.protocol === payload.data.protocol,
  );
  if (!target) {
    return NextResponse.json({ error: "Adapter binding candidate not found for protocol" }, { status: 404 });
  }

  stateStore.selectDeviceAdapterBinding(id, payload.data.adapterId, payload.data.protocol);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Selected adapter ${payload.data.adapterId} for ${device.name} (${payload.data.protocol})`,
    context: {
      deviceId: id,
      adapterId: payload.data.adapterId,
      protocol: payload.data.protocol,
    },
  });

  return NextResponse.json({
    bindings: stateStore.getDeviceAdapterBindings(id),
  });
}
