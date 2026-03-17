import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { gatewayRepository } from "@/lib/gateway/repository";
import { missionRepository } from "@/lib/missions/repository";
import { stateStore } from "@/lib/state/store";
import { subagentRepository } from "@/lib/subagents/repository";

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
  missionId: z.string().min(1).optional(),
  subagentId: z.string().min(1).optional(),
  gatewayThreadId: z.string().min(1).optional(),
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
  if (payload.data.missionId && !missionRepository.getById(payload.data.missionId)) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }
  if (payload.data.subagentId && !subagentRepository.getById(payload.data.subagentId)) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
  if (payload.data.gatewayThreadId && !gatewayRepository.getThreadById(payload.data.gatewayThreadId)) {
    return NextResponse.json({ error: "Gateway thread not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const mission = payload.data.missionId ? missionRepository.getById(payload.data.missionId) : undefined;
  const gatewayThread = payload.data.gatewayThreadId ? gatewayRepository.getThreadById(payload.data.gatewayThreadId) : undefined;
  const session = {
    id: randomUUID(),
    title: payload.data.title ?? "New Chat",
    deviceId: payload.data.deviceId ?? missionRepository.getPrimaryDeviceId(payload.data.missionId ?? ""),
    missionId: payload.data.missionId ?? gatewayThread?.missionId,
    subagentId: payload.data.subagentId ?? mission?.subagentId ?? gatewayThread?.subagentId,
    gatewayThreadId: payload.data.gatewayThreadId,
    provider: payload.data.provider,
    model: payload.data.model,
    createdAt: now,
    updatedAt: now,
  };

  stateStore.createChatSession(session);
  if (gatewayThread) {
    gatewayRepository.upsertThread({
      ...gatewayThread,
      missionId: session.missionId ?? gatewayThread.missionId,
      subagentId: session.subagentId ?? gatewayThread.subagentId,
      chatSessionId: session.id,
      updatedAt: now,
    });
  }
  return NextResponse.json(session, { status: 201 });
}
