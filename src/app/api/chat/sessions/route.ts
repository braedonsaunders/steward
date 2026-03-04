import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessions = stateStore.getChatSessions();
  return NextResponse.json(sessions);
}

const createSchema = z.object({
  title: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = createSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  if (payload.data.deviceId && !stateStore.getDeviceById(payload.data.deviceId)) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: payload.data.title ?? "New Chat",
    deviceId: payload.data.deviceId,
    provider: payload.data.provider,
    model: payload.data.model,
    createdAt: now,
    updatedAt: now,
  };

  stateStore.createChatSession(session);
  return NextResponse.json(session, { status: 201 });
}
