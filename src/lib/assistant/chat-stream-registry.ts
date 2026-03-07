type ActiveChatStream = {
  controller: AbortController;
  startedAt: string;
};

const activeChatStreams = new Map<string, ActiveChatStream>();

export function registerActiveChatStream(sessionId: string, controller: AbortController): void {
  activeChatStreams.set(sessionId, {
    controller,
    startedAt: new Date().toISOString(),
  });
}

export function releaseActiveChatStream(sessionId: string, controller?: AbortController): void {
  const active = activeChatStreams.get(sessionId);
  if (!active) {
    return;
  }
  if (controller && active.controller !== controller) {
    return;
  }
  activeChatStreams.delete(sessionId);
}

export function cancelActiveChatStream(sessionId: string): boolean {
  const active = activeChatStreams.get(sessionId);
  if (!active) {
    return false;
  }
  active.controller.abort();
  return true;
}

