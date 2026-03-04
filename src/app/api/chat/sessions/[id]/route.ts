import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const session = stateStore.getChatSessionById(id);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const messages = stateStore.getChatMessages(id);
  return NextResponse.json({ ...session, messages });
}

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  deviceId: z.string().min(1).nullable().optional(),
}).refine((data) => data.title !== undefined || data.deviceId !== undefined, {
  message: "At least one field is required",
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = patchSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const session = stateStore.getChatSessionById(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (payload.data.deviceId && !stateStore.getDeviceById(payload.data.deviceId)) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  if (payload.data.title !== undefined) {
    stateStore.updateChatSessionTitle(id, payload.data.title);
  }

  if (payload.data.deviceId !== undefined) {
    stateStore.updateChatSessionDevice(id, payload.data.deviceId ?? undefined);
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  stateStore.deleteChatSession(id);
  return NextResponse.json({ ok: true });
}
