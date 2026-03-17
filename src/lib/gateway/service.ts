import { randomUUID } from "node:crypto";
import { gatewayRepository } from "@/lib/gateway/repository";
import { createMissionThreadChatSession } from "@/lib/missions/service";
import { stateStore } from "@/lib/state/store";

function nowIso(): string {
  return new Date().toISOString();
}

export function ensureThreadChatSession(threadId: string): string | undefined {
  const thread = gatewayRepository.getThreadById(threadId);
  if (!thread) {
    return undefined;
  }

  const existing = thread.chatSessionId
    ? stateStore.getChatSessionById(thread.chatSessionId)
    : stateStore.getChatSessionByGatewayThreadId(thread.id);
  if (existing) {
    if (!thread.chatSessionId || existing.id !== thread.chatSessionId) {
      gatewayRepository.upsertThread({
        ...thread,
        chatSessionId: existing.id,
        updatedAt: nowIso(),
      });
    }
    stateStore.updateChatSessionContext(existing.id, {
      title: thread.title,
      missionId: thread.missionId ?? null,
      subagentId: thread.subagentId ?? null,
      gatewayThreadId: thread.id,
    });
    return existing.id;
  }

  const sessionId = createMissionThreadChatSession({
    title: thread.title,
    missionId: thread.missionId,
    subagentId: thread.subagentId,
    gatewayThreadId: thread.id,
    provider: "telegram",
  });
  gatewayRepository.upsertThread({
    ...thread,
    chatSessionId: sessionId,
    updatedAt: nowIso(),
  });
  return sessionId;
}

export function appendGatewayConversationTurn(args: {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  error?: boolean;
}): string | undefined {
  const sessionId = ensureThreadChatSession(args.threadId);
  if (!sessionId) {
    return undefined;
  }

  stateStore.addChatMessage({
    id: randomUUID(),
    sessionId,
    role: args.role,
    content: args.content,
    provider: args.provider,
    error: args.error ?? false,
    createdAt: nowIso(),
  });
  return sessionId;
}
