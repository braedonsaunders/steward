import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { gatewayRepository } from "@/lib/gateway/repository";
import { missionRepository } from "@/lib/missions/repository";
import { stateStore } from "@/lib/state/store";
import { subagentRepository } from "@/lib/subagents/repository";

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
  missionId: z.string().min(1).nullable().optional(),
  subagentId: z.string().min(1).nullable().optional(),
  gatewayThreadId: z.string().min(1).nullable().optional(),
}).refine((data) => (
  data.title !== undefined
  || data.deviceId !== undefined
  || data.missionId !== undefined
  || data.subagentId !== undefined
  || data.gatewayThreadId !== undefined
), {
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
  if (payload.data.missionId && !missionRepository.getById(payload.data.missionId)) {
    return NextResponse.json({ error: "Mission not found" }, { status: 404 });
  }
  if (payload.data.subagentId && !subagentRepository.getById(payload.data.subagentId)) {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
  if (payload.data.gatewayThreadId && !gatewayRepository.getThreadById(payload.data.gatewayThreadId)) {
    return NextResponse.json({ error: "Gateway thread not found" }, { status: 404 });
  }

  const mission = payload.data.missionId === undefined
    ? (session.missionId ? missionRepository.getById(session.missionId) : undefined)
    : payload.data.missionId
      ? missionRepository.getById(payload.data.missionId)
      : undefined;
  const nextGatewayThread = payload.data.gatewayThreadId === undefined
    ? (session.gatewayThreadId ? gatewayRepository.getThreadById(session.gatewayThreadId) : undefined)
    : payload.data.gatewayThreadId
      ? gatewayRepository.getThreadById(payload.data.gatewayThreadId)
      : undefined;
  const nextMissionId = payload.data.missionId === undefined ? session.missionId : payload.data.missionId ?? undefined;
  const nextSubagentId = payload.data.subagentId === undefined
    ? session.subagentId ?? mission?.subagentId ?? nextGatewayThread?.subagentId
    : payload.data.subagentId ?? undefined;
  const nextGatewayThreadId = payload.data.gatewayThreadId === undefined ? session.gatewayThreadId : payload.data.gatewayThreadId ?? undefined;
  stateStore.updateChatSessionContext(id, {
    title: payload.data.title,
    deviceId: payload.data.deviceId === undefined
      ? session.deviceId ?? missionRepository.getPrimaryDeviceId(nextMissionId ?? "")
      : payload.data.deviceId,
    missionId: nextMissionId,
    subagentId: nextSubagentId,
    gatewayThreadId: nextGatewayThreadId,
  });
  if (nextGatewayThread) {
    gatewayRepository.upsertThread({
      ...nextGatewayThread,
      missionId: nextMissionId ?? nextGatewayThread.missionId,
      subagentId: nextSubagentId ?? nextGatewayThread.subagentId,
      chatSessionId: id,
      updatedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json(stateStore.getChatSessionById(id));
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
