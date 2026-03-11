"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { withClientApiToken } from "@/lib/auth/client-token";
import type {
  ChatMessage as PersistedChatMessage,
  ChatMessageMetadata,
  ChatToolEvent,
  LLMProvider,
} from "@/lib/state/types";

export interface ChatSessionRecord {
  id: string;
  title: string;
  deviceId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChatMessageRecord = PersistedChatMessage & {
  reasoning?: string;
  streaming?: boolean;
};

type ChatStreamEvent =
  | { type: "start"; provider?: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-event"; event: ChatToolEvent }
  | { type: "finish"; provider?: string; text?: string; reasoning?: string; metadata?: ChatMessageMetadata }
  | { type: "error"; error: string; provider?: string };

type StreamChatResult = {
  sawTerminalEvent: boolean;
};

interface SendMessageOptions {
  text: string;
  provider: LLMProvider;
  sessionId?: string | null;
  deviceId?: string;
  suppressUserMessage?: boolean;
  autoTitle?: boolean;
}

interface SendMessageResult {
  ok: boolean;
  sessionId?: string;
}

interface ChatRuntimeContextValue {
  sessions: ChatSessionRecord[];
  sessionsLoading: boolean;
  sending: boolean;
  sendStartedAt: number | null;
  streamingSessionId: string | null;
  refreshSessions: () => Promise<void>;
  isSessionLoaded: (sessionId: string) => boolean;
  isSessionLoading: (sessionId: string) => boolean;
  getSessionMessages: (sessionId: string | null | undefined) => ChatMessageRecord[];
  loadSessionMessages: (sessionId: string, options?: { silent?: boolean }) => Promise<ChatMessageRecord[]>;
  createSession: (deviceId?: string) => Promise<ChatSessionRecord | null>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendMessage: (options: SendMessageOptions) => Promise<SendMessageResult>;
  stopStreaming: (sessionId?: string | null) => void;
}

const ChatRuntimeContext = createContext<ChatRuntimeContextValue | null>(null);

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted|aborterror/i.test(error.message);
  }

  return false;
}

function collapseWhitespaceForMessageMerge(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mergeAssistantContent(current: string, incoming?: string): string {
  if (typeof incoming !== "string" || incoming.length === 0) {
    return current;
  }
  if (current.length === 0) {
    return incoming;
  }
  if (incoming === current) {
    return incoming;
  }
  if (incoming.startsWith(current)) {
    return incoming;
  }
  if (current.startsWith(incoming)) {
    return current;
  }

  const normalizedCurrent = collapseWhitespaceForMessageMerge(current);
  const normalizedIncoming = collapseWhitespaceForMessageMerge(incoming);
  if (normalizedIncoming.startsWith(normalizedCurrent)) {
    return incoming;
  }
  if (normalizedCurrent.startsWith(normalizedIncoming)) {
    return current;
  }

  return incoming.length >= current.length ? incoming : current;
}

function mergeToolEvent(events: ChatToolEvent[] | undefined, incoming: ChatToolEvent): ChatToolEvent[] {
  const next = [...(events ?? [])];
  const existingIndex = next.findIndex((event) => event.id === incoming.id);
  if (existingIndex === -1) {
    next.push(incoming);
    return next;
  }

  next[existingIndex] = {
    ...next[existingIndex],
    ...incoming,
    anchorOffset: incoming.anchorOffset ?? next[existingIndex].anchorOffset,
  };
  return next;
}

function isInterruptedMessage(message: ChatMessageRecord | undefined): boolean {
  return Boolean(message?.metadata?.interrupted);
}

function isTerminalAssistantMessage(
  message: ChatMessageRecord | undefined,
  options?: { allowInterrupted?: boolean },
): boolean {
  if (!message || message.role !== "assistant" || message.streaming) {
    return false;
  }
  if (message.error) {
    return true;
  }
  return options?.allowInterrupted ? true : !isInterruptedMessage(message);
}

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessageRecord[]>>({});
  const [loadedSessionIds, setLoadedSessionIds] = useState<Record<string, boolean>>({});
  const [loadingSessionIds, setLoadingSessionIds] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState<number | null>(null);
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null);

  const sessionsRef = useRef<ChatSessionRecord[]>([]);
  const freshSessionIdsRef = useRef<Set<string>>(new Set());
  const refreshSessionsRequestIdRef = useRef(0);
  const pendingSessionLoadsRef = useRef<Map<string, Promise<ChatMessageRecord[]>>>(new Map());
  const activeStreamAbortRef = useRef<AbortController | null>(null);
  const activeStreamSessionIdRef = useRef<string | null>(null);
  const manuallyStoppedSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const upsertSessionRecord = useCallback((session: ChatSessionRecord) => {
    setSessions((prev) => {
      const withoutCurrent = prev.filter((item) => item.id !== session.id);
      const next = [session, ...withoutCurrent];
      next.sort((left, right) => (
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      ));
      return next;
    });
  }, []);

  const setSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessageRecord[]) => ChatMessageRecord[]) => {
      setMessagesBySession((prev) => {
        const current = prev[sessionId] ?? [];
        const next = updater(current);
        if (next === current) {
          return prev;
        }
        return {
          ...prev,
          [sessionId]: next,
        };
      });
    },
    [],
  );

  const refreshSessions = useCallback(async () => {
    const requestId = refreshSessionsRequestIdRef.current + 1;
    refreshSessionsRequestIdRef.current = requestId;
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/chat/sessions", withClientApiToken({ cache: "no-store" }));
      const data = (await res.json()) as ChatSessionRecord[];
      if (refreshSessionsRequestIdRef.current === requestId) {
        setSessions(data);
      }
    } finally {
      if (refreshSessionsRequestIdRef.current === requestId) {
        setSessionsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const loadSessionMessages = useCallback(
    async (sessionId: string, options?: { silent?: boolean }): Promise<ChatMessageRecord[]> => {
      const existingRequest = pendingSessionLoadsRef.current.get(sessionId);
      if (existingRequest) {
        if (!options?.silent) {
          setLoadingSessionIds((prev) => ({ ...prev, [sessionId]: true }));
        }

        try {
          return await existingRequest;
        } finally {
          if (!options?.silent) {
            setLoadingSessionIds((prev) => {
              const next = { ...prev };
              delete next[sessionId];
              return next;
            });
          }
        }
      }

      if (!options?.silent) {
        setLoadingSessionIds((prev) => ({ ...prev, [sessionId]: true }));
      }

      const request = (async (): Promise<ChatMessageRecord[]> => {
        try {
          const res = await fetch(`/api/chat/sessions/${sessionId}`, withClientApiToken({ cache: "no-store" }));
          const data = (await res.json()) as ChatSessionRecord & { messages: ChatMessageRecord[] };
          const nextMessages = data.messages ?? [];
          const { messages: _messages, ...session } = data;
          void _messages;

          upsertSessionRecord(session);
          setMessagesBySession((prev) => ({
            ...prev,
            [sessionId]: nextMessages,
          }));
          setLoadedSessionIds((prev) => ({ ...prev, [sessionId]: true }));
          return nextMessages;
        } catch {
          if (!options?.silent) {
            setMessagesBySession((prev) => ({
              ...prev,
              [sessionId]: [],
            }));
            setLoadedSessionIds((prev) => ({ ...prev, [sessionId]: true }));
          }
          return [];
        }
      })();

      pendingSessionLoadsRef.current.set(sessionId, request);

      try {
        return await request;
      } finally {
        pendingSessionLoadsRef.current.delete(sessionId);
        if (!options?.silent) {
          setLoadingSessionIds((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
          });
        }
      }
    },
    [upsertSessionRecord],
  );

  const createSession = useCallback(async (deviceId?: string) => {
    try {
      const res = await fetch("/api/chat/sessions", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New Chat", deviceId }),
      }));
      const session = (await res.json()) as ChatSessionRecord;
      freshSessionIdsRef.current.add(session.id);
      upsertSessionRecord(session);
      setMessagesBySession((prev) => ({ ...prev, [session.id]: [] }));
      setLoadedSessionIds((prev) => ({ ...prev, [session.id]: true }));
      return session;
    } catch {
      return null;
    }
  }, [upsertSessionRecord]);

  const renameSession = useCallback(async (id: string, title: string) => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    await fetch(`/api/chat/sessions/${id}`, withClientApiToken({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmedTitle }),
    }));

    setSessions((prev) =>
      prev.map((session) => (
        session.id === id
          ? { ...session, title: trimmedTitle }
          : session
      )),
    );
  }, []);

  const stopStreaming = useCallback((sessionId?: string | null) => {
    const activeSessionId = activeStreamSessionIdRef.current;
    if (!activeSessionId) {
      return;
    }
    if (sessionId && activeSessionId !== sessionId) {
      return;
    }
    manuallyStoppedSessionIdsRef.current.add(activeSessionId);
    void fetch("/api/chat/cancel", withClientApiToken({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: activeSessionId }),
    })).catch(() => {
      // Local abort still stops the client stream even if the cancel request fails.
    });
    activeStreamAbortRef.current?.abort();
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    stopStreaming(id);
    await fetch(`/api/chat/sessions/${id}`, withClientApiToken({ method: "DELETE" }));
    setSessions((prev) => prev.filter((session) => session.id !== id));
    setMessagesBySession((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLoadedSessionIds((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLoadingSessionIds((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    freshSessionIdsRef.current.delete(id);
  }, [stopStreaming]);

  const streamChat = useCallback(
    async (
      payload: {
        input: string;
        provider: LLMProvider;
        sessionId: string;
        suppressUserMessage?: boolean;
      },
      onEvent: (event: ChatStreamEvent) => void,
      options?: { signal?: AbortSignal },
    ): Promise<StreamChatResult> => {
      const res = await fetch("/api/chat", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, stream: true }),
        signal: options?.signal,
      }));

      if (!res.ok || !res.body) {
        const message = await res.text();
        throw new Error(message || `Request failed with ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawTerminalEvent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          try {
            const event = JSON.parse(line) as ChatStreamEvent;
            if (event.type === "finish" || event.type === "error") {
              sawTerminalEvent = true;
            }
            onEvent(event);
          } catch {
            // Ignore malformed event chunks.
          }
        }
      }

      const finalLine = buffer.trim();
      if (finalLine) {
        try {
          const event = JSON.parse(finalLine) as ChatStreamEvent;
          if (event.type === "finish" || event.type === "error") {
            sawTerminalEvent = true;
          }
          onEvent(event);
        } catch {
          // Ignore malformed final chunk.
        }
      }

      return { sawTerminalEvent };
    },
    [],
  );

  const reconcileSessionMessages = useCallback(
    async (
      sessionId: string,
      attempts: number,
      options?: { allowInterrupted?: boolean },
    ): Promise<ChatMessageRecord[]> => {
      let syncedMessages: ChatMessageRecord[] = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        syncedMessages = await loadSessionMessages(sessionId, { silent: true });
        if (isTerminalAssistantMessage(syncedMessages.at(-1), options)) {
          return syncedMessages;
        }
        if (attempt < attempts - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      return syncedMessages;
    },
    [loadSessionMessages],
  );

  const sendMessage = useCallback(async (options: SendMessageOptions): Promise<SendMessageResult> => {
    const trimmed = options.text.trim();
    if (!trimmed || sending) {
      return { ok: false };
    }

    let sessionId = options.sessionId ?? null;
    if (!sessionId) {
      const session = await createSession(options.deviceId);
      if (!session) {
        return { ok: false };
      }
      sessionId = session.id;
    }

    const now = new Date().toISOString();
    if (!options.suppressUserMessage) {
      const userMessage: ChatMessageRecord = {
        id: crypto.randomUUID(),
        sessionId,
        role: "user",
        content: trimmed,
        error: false,
        createdAt: now,
      };
      setSessionMessages(sessionId, (prev) => [...prev, userMessage]);
    }

    setLoadedSessionIds((prev) => ({ ...prev, [sessionId]: true }));
    setSending(true);
    const startedAt = Date.now();
    setSendStartedAt(startedAt);
    setStreamingSessionId(sessionId);
    activeStreamSessionIdRef.current = sessionId;

    const assistantId = crypto.randomUUID();
    const abortController = new AbortController();
    activeStreamAbortRef.current = abortController;
    const assistantDraft: ChatMessageRecord = {
      id: assistantId,
      sessionId,
      role: "assistant",
      content: "",
      reasoning: "",
      streaming: true,
      provider: options.provider,
      error: false,
      createdAt: new Date().toISOString(),
    };
    setSessionMessages(sessionId, (prev) => [...prev, assistantDraft]);

    try {
      const streamResult = await streamChat(
        {
          input: trimmed,
          provider: options.provider,
          sessionId,
          suppressUserMessage: options.suppressUserMessage,
        },
        (event) => {
          if (event.type === "start") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      provider: event.provider ?? message.provider,
                    }
                  : message,
              ),
            );
            return;
          }

          if (event.type === "tool-event") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        toolEvents: mergeToolEvent(message.metadata?.toolEvents, event.event),
                      },
                    }
                  : message,
              ),
            );
            return;
          }

          if (event.type === "text-delta") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + event.text }
                  : message,
              ),
            );
            return;
          }

          if (event.type === "reasoning-delta") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, reasoning: (message.reasoning ?? "") + event.text }
                  : message,
              ),
            );
            return;
          }

          if (event.type === "finish") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content: mergeAssistantContent(message.content, event.text),
                      reasoning: event.reasoning ?? message.reasoning,
                      metadata: event.metadata ?? message.metadata,
                      provider: event.provider ?? message.provider,
                      streaming: false,
                    }
                  : message,
              ),
            );
            return;
          }

          if (event.type === "error") {
            setSessionMessages(sessionId, (prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      content: event.error,
                      provider: event.provider ?? message.provider,
                      error: true,
                      streaming: false,
                    }
                  : message,
              ),
            );
          }
        },
        { signal: abortController.signal },
      );

      setSessionMessages(sessionId, (prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, streaming: false }
            : message,
        ),
      );

      const manuallyStopped = manuallyStoppedSessionIdsRef.current.delete(sessionId);
      const syncedMessages = await reconcileSessionMessages(
        sessionId,
        streamResult.sawTerminalEvent ? 2 : 5,
        { allowInterrupted: manuallyStopped },
      );

      if (!streamResult.sawTerminalEvent && !isTerminalAssistantMessage(syncedMessages.at(-1), { allowInterrupted: manuallyStopped })) {
        setSessionMessages(sessionId, () => [
          ...syncedMessages,
          {
            id: assistantId,
            sessionId,
            role: "assistant",
            content: "The live stream ended before Steward confirmed completion. The thread state has been reloaded; if the saved reply does not appear, retry the last message.",
            provider: options.provider,
            error: true,
            createdAt: new Date().toISOString(),
            metadata: { interrupted: true },
          },
        ]);
      }

      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (options.autoTitle && session && session.title === "New Chat") {
        const autoTitle = trimmed.length > 40 ? `${trimmed.slice(0, 40)}...` : trimmed;
        void renameSession(sessionId, autoTitle);
      }

      setSessions((prev) => {
        const index = prev.findIndex((item) => item.id === sessionId);
        if (index === -1) {
          return prev;
        }

        const updatedSession = {
          ...prev[index],
          updatedAt: new Date().toISOString(),
        };

        const next = [...prev];
        next.splice(index, 1);
        next.unshift(updatedSession);
        return next;
      });

      return { ok: true, sessionId };
    } catch (error) {
      if (isAbortError(error)) {
        const manuallyStopped = manuallyStoppedSessionIdsRef.current.delete(sessionId);
        if (!manuallyStopped) {
          const syncedMessages = await reconcileSessionMessages(sessionId, 6);
          if (isTerminalAssistantMessage(syncedMessages.at(-1))) {
            return { ok: true, sessionId };
          }
        }

        setSessionMessages(sessionId, (prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  content: message.content.trim().length > 0 ? message.content : "Response interrupted.",
                  metadata: {
                    ...message.metadata,
                    interrupted: true,
                  },
                  streaming: false,
                }
              : message,
          ),
        );
        return { ok: false, sessionId };
      }

      const syncedMessages = await reconcileSessionMessages(sessionId, 6);
      if (isTerminalAssistantMessage(syncedMessages.at(-1))) {
        return { ok: true, sessionId };
      }

      setSessionMessages(sessionId, (prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: error instanceof Error ? error.message : "An unexpected error occurred.",
                error: true,
                streaming: false,
              }
            : message,
        ),
      );
      return { ok: false, sessionId };
    } finally {
      manuallyStoppedSessionIdsRef.current.delete(sessionId);
      if (activeStreamAbortRef.current === abortController) {
        activeStreamAbortRef.current = null;
      }
      if (activeStreamSessionIdRef.current === sessionId) {
        activeStreamSessionIdRef.current = null;
      }
      setSending(false);
      setSendStartedAt(null);
      setStreamingSessionId(null);
    }
  }, [createSession, reconcileSessionMessages, renameSession, sending, setSessionMessages, streamChat]);

  useEffect(() => {
    return () => {
      activeStreamAbortRef.current?.abort();
      activeStreamAbortRef.current = null;
      activeStreamSessionIdRef.current = null;
    };
  }, []);

  const value = useMemo<ChatRuntimeContextValue>(() => ({
    sessions,
    sessionsLoading,
    sending,
    sendStartedAt,
    streamingSessionId,
    refreshSessions,
    isSessionLoaded: (sessionId: string) => Boolean(loadedSessionIds[sessionId] || freshSessionIdsRef.current.has(sessionId)),
    isSessionLoading: (sessionId: string) => Boolean(loadingSessionIds[sessionId]),
    getSessionMessages: (sessionId: string | null | undefined) => (sessionId ? messagesBySession[sessionId] ?? [] : []),
    loadSessionMessages,
    createSession,
    deleteSession,
    renameSession,
    sendMessage,
    stopStreaming,
  }), [
    createSession,
    deleteSession,
    loadSessionMessages,
    loadedSessionIds,
    loadingSessionIds,
    messagesBySession,
    refreshSessions,
    renameSession,
    sendMessage,
    sending,
    sendStartedAt,
    sessions,
    sessionsLoading,
    stopStreaming,
    streamingSessionId,
  ]);

  return (
    <ChatRuntimeContext.Provider value={value}>
      {children}
    </ChatRuntimeContext.Provider>
  );
}

export function useChatRuntime(): ChatRuntimeContextValue {
  const context = useContext(ChatRuntimeContext);
  if (!context) {
    throw new Error("useChatRuntime must be used within a ChatRuntimeProvider");
  }
  return context;
}
