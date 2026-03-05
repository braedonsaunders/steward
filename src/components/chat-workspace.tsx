"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bot,
  Edit3,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Server,
  Trash2,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSteward } from "@/lib/hooks/use-steward";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type { LLMProvider } from "@/lib/state/types";
import { withClientApiToken } from "@/lib/auth/client-token";

export interface ChatWorkspaceProps {
  initialDeviceId?: string;
  autostart?: boolean;
  respectUrlParams?: boolean;
  compact?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  deviceId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  streaming?: boolean;
  provider?: string;
  error: boolean;
  createdAt: string;
}

type ChatStreamEvent =
  | { type: "start"; provider?: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "finish"; provider?: string; text?: string; reasoning?: string }
  | { type: "error"; error: string; provider?: string };

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function ChatWorkspace({
  initialDeviceId,
  autostart,
  respectUrlParams = true,
  compact = false,
}: ChatWorkspaceProps = {}) {
  const { devices, providerConfigs, loading: contextLoading } = useSteward();
  const searchParams = useSearchParams();

  // Sessions
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Messages for active session
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Chat input
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>("openai");

  // UI
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [newChatDeviceId, setNewChatDeviceId] = useState<string>("__none__");
  const [groupBy, setGroupBy] = useState<"recent" | "device">("recent");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const deepLinkAppliedRef = useRef(false);
  const enabledProviders = providerConfigs.filter((config) => config.enabled);
  const deviceById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const requestedDeviceId = initialDeviceId
    ?? (respectUrlParams ? searchParams.get("deviceId") : null);
  const autostartParam = respectUrlParams ? searchParams.get("autostart") : null;
  const urlAutostart = autostartParam === null ? false : autostartParam !== "0";
  const shouldAutostart = autostart ?? urlAutostart;

  const activeConfig = providerConfigs.find((c) => c.provider === selectedProvider);
  const activeModel = activeConfig?.model ?? "default";
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeSessionDevice = activeSession?.deviceId
    ? deviceById.get(activeSession.deviceId)
    : undefined;

  const groupedSessions = useMemo(() => {
    if (groupBy === "recent") {
      return [{ key: "recent", label: "Recent", sessions }];
    }

    const bucket = new Map<string, ChatSession[]>();
    const unassigned: ChatSession[] = [];

    for (const session of sessions) {
      if (!session.deviceId || !deviceById.has(session.deviceId)) {
        unassigned.push(session);
        continue;
      }
      const existing = bucket.get(session.deviceId) ?? [];
      existing.push(session);
      bucket.set(session.deviceId, existing);
    }

    const grouped = Array.from(bucket.entries())
      .map(([deviceId, groupedItems]) => ({
        key: deviceId,
        label: deviceById.get(deviceId)?.name ?? "Unknown device",
        sessions: groupedItems,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    if (unassigned.length > 0) {
      grouped.push({ key: "unassigned", label: "Unassigned", sessions: unassigned });
    }

    return grouped;
  }, [deviceById, groupBy, sessions]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const syncSidebarMode = () => setSidebarOpen(!query.matches);
    syncSidebarMode();
    query.addEventListener("change", syncSidebarMode);
    return () => query.removeEventListener("change", syncSidebarMode);
  }, []);

  // Sync selected provider with enabled providers
  useEffect(() => {
    if (enabledProviders.length === 0) return;
    const selectedStillEnabled = enabledProviders.some(
      (config) => config.provider === selectedProvider,
    );
    if (!selectedStillEnabled) {
      setSelectedProvider(enabledProviders[0].provider);
    }
  }, [enabledProviders, selectedProvider]);

  // Load sessions on mount
  useEffect(() => {
    fetch("/api/chat/sessions", withClientApiToken())
      .then((res) => res.json())
      .then((data: ChatSession[]) => {
        setSessions(data);
        setSessionsLoading(false);
      })
      .catch(() => setSessionsLoading(false));
  }, []);

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    setMessagesLoading(true);
    fetch(`/api/chat/sessions/${activeSessionId}`, withClientApiToken())
      .then((res) => res.json())
      .then((data: ChatSession & { messages: ChatMessage[] }) => {
        setMessages(data.messages ?? []);
        setMessagesLoading(false);
      })
      .catch(() => {
        setMessages([]);
        setMessagesLoading(false);
      });
  }, [activeSessionId]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, sending]);

  const createSession = useCallback(async (deviceId?: string) => {
    try {
      const res = await fetch("/api/chat/sessions", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New Chat", deviceId }),
      }));
      const session = (await res.json()) as ChatSession;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      setTimeout(() => textareaRef.current?.focus(), 100);
      return session;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    deepLinkAppliedRef.current = false;
  }, [requestedDeviceId, shouldAutostart]);

  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (!requestedDeviceId) return;
    if (contextLoading || sessionsLoading) return;

    deepLinkAppliedRef.current = true;
    if (!deviceById.has(requestedDeviceId)) return;

    setNewChatDeviceId(requestedDeviceId);
    setGroupBy("device");

    const matchingSession = sessions.find((session) => session.deviceId === requestedDeviceId);
    if (matchingSession) {
      setActiveSessionId(matchingSession.id);
      return;
    }

    if (shouldAutostart) {
      void createSession(requestedDeviceId);
    }
  }, [
    contextLoading,
    createSession,
    deviceById,
    requestedDeviceId,
    sessions,
    sessionsLoading,
    shouldAutostart,
  ]);

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/chat/sessions/${id}`, withClientApiToken({ method: "DELETE" }));
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setMessages([]);
      }
    },
    [activeSessionId],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      if (!title.trim()) return;
      await fetch(`/api/chat/sessions/${id}`, withClientApiToken({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      }));
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: title.trim() } : s)),
      );
      setEditingSessionId(null);
    },
    [],
  );

  const streamChat = useCallback(
    async (
      payload: {
        input: string;
        provider: LLMProvider;
        sessionId: string;
      },
      onEvent: (event: ChatStreamEvent) => void,
    ) => {
      const res = await fetch("/api/chat", withClientApiToken({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, stream: true }),
      }));

      if (!res.ok || !res.body) {
        const message = await res.text();
        throw new Error(message || `Request failed with ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
          onEvent(event);
        } catch {
          // Ignore malformed final chunk.
        }
      }
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending || enabledProviders.length === 0) return;

    let sessionId = activeSessionId;

    // Auto-create session if none selected
    if (!sessionId) {
      const session = await createSession(
        newChatDeviceId === "__none__" ? undefined : newChatDeviceId,
      );
      if (!session) return;
      sessionId = session.id;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: trimmed,
      error: false,
      createdAt: now,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);

    setTimeout(() => textareaRef.current?.focus(), 0);

    const assistantId = crypto.randomUUID();
    const assistantDraft: ChatMessage = {
      id: assistantId,
      sessionId,
      role: "assistant",
      content: "",
      reasoning: "",
      streaming: true,
      provider: selectedProvider,
      error: false,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantDraft]);

    try {
      await streamChat(
        { input: trimmed, provider: selectedProvider, sessionId },
        (event) => {
          if (event.type === "start") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      provider: event.provider ?? msg.provider,
                    }
                  : msg,
              ),
            );
            return;
          }

          if (event.type === "text-delta") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: msg.content + event.text }
                  : msg,
              ),
            );
            return;
          }

          if (event.type === "reasoning-delta") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      reasoning: (msg.reasoning ?? "") + event.text,
                    }
                  : msg,
              ),
            );
            return;
          }

          if (event.type === "finish") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      content: event.text ?? msg.content,
                      reasoning: event.reasoning ?? msg.reasoning,
                      provider: event.provider ?? msg.provider,
                      streaming: false,
                    }
                  : msg,
              ),
            );
            return;
          }

          if (event.type === "error") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      content: event.error,
                      provider: event.provider ?? msg.provider,
                      error: true,
                      streaming: false,
                    }
                  : msg,
              ),
            );
          }
        },
      );

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId ? { ...msg, streaming: false } : msg,
        ),
      );

      // Auto-title on first message
      const session = sessions.find((s) => s.id === sessionId);
      if (session && session.title === "New Chat") {
        const autoTitle = trimmed.length > 40 ? trimmed.slice(0, 40) + "..." : trimmed;
        void renameSession(sessionId, autoTitle);
      }

      // Bump session to top
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === sessionId);
        if (idx <= 0) return prev;
        const updated = [...prev];
        const [item] = updated.splice(idx, 1);
        updated.unshift({ ...item, updatedAt: new Date().toISOString() });
        return updated;
      });
    } catch (err) {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: err instanceof Error ? err.message : "An unexpected error occurred.",
                error: true,
                streaming: false,
              }
            : msg,
        ),
      );
    } finally {
      setSending(false);
    }
  }, [
    activeSessionId,
    createSession,
    enabledProviders.length,
    input,
    newChatDeviceId,
    renameSession,
    selectedProvider,
    sending,
    sessions,
    streamChat,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-1 overflow-hidden">
      {/* Sidebar */}
      <div
        className={cn(
          "z-30 flex h-full shrink-0 flex-col border-r bg-card/40 transition-all duration-200",
          sidebarOpen
            ? cn(
                "absolute inset-y-0 left-0 md:relative",
                compact ? "w-[min(82vw,300px)] md:w-[228px]" : "w-[min(86vw,320px)] md:w-[260px]",
              )
            : "w-0 -translate-x-full overflow-hidden border-r-0 md:translate-x-0",
        )}
      >
        {/* Sidebar header */}
        <div className={cn("space-y-2 border-b px-3 py-3", compact && "space-y-1.5 px-2.5 py-2.5")}>
          <div className={cn("flex items-center gap-2", compact && "gap-1.5")}>
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-8 flex-1 justify-start gap-2 text-xs", compact && "h-7 gap-1.5 px-2 text-[11px]")}
              onClick={() =>
                void createSession(newChatDeviceId === "__none__" ? undefined : newChatDeviceId)
              }
            >
              <MessageSquarePlus className={cn("h-3.5 w-3.5", compact && "h-3 w-3")} />
              New Chat
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 shrink-0", compact && "h-7 w-7")}
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeftClose className={cn("h-3.5 w-3.5", compact && "h-3 w-3")} />
            </Button>
          </div>

          <div className={cn("grid gap-2", compact && "gap-1.5")}>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("w-11 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground", compact && "w-10 text-[9px]")}>
                Device
              </span>
              <Select value={newChatDeviceId} onValueChange={setNewChatDeviceId}>
                <SelectTrigger className={cn("h-7 min-w-0 flex-1 px-2 text-[11px]", !compact && "h-8 text-xs")}>
                  <SelectValue placeholder="Any device" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Any device</SelectItem>
                  {devices.map((device) => (
                    <SelectItem key={device.id} value={device.id}>
                      {device.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("w-11 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground", compact && "w-10 text-[9px]")}>
                Group
              </span>
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 rounded-md border bg-background/60 p-1">
                <Button
                  type="button"
                  size="sm"
                  variant={groupBy === "recent" ? "secondary" : "ghost"}
                  className={cn("h-6 px-2 text-[11px]", groupBy === "recent" ? "shadow-none" : "")}
                  onClick={() => setGroupBy("recent")}
                >
                  Recent
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={groupBy === "device" ? "secondary" : "ghost"}
                  className={cn("h-6 px-2 text-[11px]", groupBy === "device" ? "shadow-none" : "")}
                  onClick={() => setGroupBy("device")}
                >
                  Device
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Session list */}
        <ScrollArea className="flex-1">
          <div className="space-y-0.5 p-2">
            {sessionsLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {!sessionsLoading && sessions.length === 0 && (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                No conversations yet
              </p>
            )}

            {groupedSessions.map((group) => (
              <div key={group.key} className="space-y-0.5">
                {groupBy === "device" && (
                  <p className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-0">
                    {group.label}
                  </p>
                )}

                {group.sessions.map((session) => {
                  const attachedDevice = session.deviceId
                    ? deviceById.get(session.deviceId)
                    : undefined;
                  return (
                    <div
                      key={session.id}
                      className={cn(
                        "group flex items-center gap-1 rounded-lg px-2 py-2 text-sm transition-colors",
                        activeSessionId === session.id
                          ? "bg-primary/10 text-primary"
                          : "text-foreground/70 hover:bg-muted/50",
                      )}
                    >
                      {editingSessionId === session.id ? (
                        <Input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={() => void renameSession(session.id, editTitle)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void renameSession(session.id, editTitle);
                            if (e.key === "Escape") setEditingSessionId(null);
                          }}
                          className="h-6 text-xs"
                          autoFocus
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => setActiveSessionId(session.id)}
                          >
                            <p className="truncate text-xs font-medium">{session.title}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {relativeDate(session.updatedAt)}
                            </p>
                            {attachedDevice && (
                              <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                                <Server className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{attachedDevice.name}</span>
                              </p>
                            )}
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                              >
                                <MoreHorizontal className="h-3 w-3" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingSessionId(session.id);
                                  setEditTitle(session.title);
                                }}
                              >
                                <Edit3 className="mr-2 h-3 w-3" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => void deleteSession(session.id)}
                              >
                                <Trash2 className="mr-2 h-3 w-3" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {sidebarOpen && (
        <button
          type="button"
          className="absolute inset-0 z-20 bg-background/45 backdrop-blur-[1px] md:hidden"
          aria-label="Close chat sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main chat area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b bg-card/60 px-4 py-3 backdrop-blur md:px-6">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 className="steward-heading-font truncate text-sm font-semibold">
              {activeSessionId
                ? activeSession?.title ?? "Chat"
                : "Chat with Steward"}
            </h1>
            {activeSessionDevice && (
              <Badge variant="secondary" className="hidden max-w-[220px] items-center gap-1 truncate md:inline-flex">
                <Server className="h-3 w-3 shrink-0" />
                <span className="truncate">{activeSessionDevice.name}</span>
              </Badge>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <Select
              value={selectedProvider}
              onValueChange={(v) => setSelectedProvider(v as LLMProvider)}
              disabled={enabledProviders.length === 0}
            >
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="Provider" />
              </SelectTrigger>
              <SelectContent>
                {enabledProviders.map((config) => {
                  const meta = PROVIDER_REGISTRY.find((p) => p.id === config.provider);
                  return (
                    <SelectItem key={config.provider} value={config.provider}>
                      {meta?.label ?? config.provider}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>

            <Badge variant="outline" className="hidden text-xs sm:inline-flex">
              {activeModel}
            </Badge>
          </div>
        </div>

        {/* Message area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
          {!activeSessionId && !contextLoading && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="rounded-full bg-primary/10 p-4">
                <Bot className="h-8 w-8 text-primary" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">Start a conversation</h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Ask Steward about your network, diagnose issues, or request remediation
                actions.
              </p>
              {newChatDeviceId !== "__none__" && deviceById.get(newChatDeviceId) && (
                <Badge variant="secondary" className="mt-3 inline-flex items-center gap-1">
                  <Server className="h-3 w-3" />
                  Attached: {deviceById.get(newChatDeviceId)?.name}
                </Badge>
              )}
              <Button
                variant="outline"
                className="mt-4"
                onClick={() =>
                  void createSession(newChatDeviceId === "__none__" ? undefined : newChatDeviceId)
                }
              >
                <MessageSquarePlus className="mr-2 h-4 w-4" />
                New Chat
              </Button>
            </div>
          )}

          {activeSessionId && messagesLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {activeSessionId && !messagesLoading && (
            <div className="space-y-4">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Bot className="h-6 w-6 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    Send a message to get started
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex gap-3",
                    msg.role === "user" ? "flex-row-reverse" : "flex-row",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {msg.role === "user" ? (
                      <User className="h-4 w-4" />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </div>

                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-2.5",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : msg.error
                          ? "border border-destructive/30 bg-destructive/10 text-destructive"
                          : "border bg-card text-card-foreground",
                    )}
                  >
                    {msg.role === "assistant" && msg.provider && !msg.error && (
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {msg.provider}
                      </p>
                    )}
                    {msg.error && (
                      <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">
                        Error
                      </p>
                    )}

                    {!!msg.reasoning && !msg.error && (
                      <div className="mb-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2">
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Thinking
                        </p>
                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                          {msg.reasoning}
                        </p>
                      </div>
                    )}

                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {msg.content || (msg.streaming ? "Thinking..." : "")}
                    </p>
                    <p
                      className={cn(
                        "mt-1.5 text-[10px]",
                        msg.role === "user"
                          ? "text-primary-foreground/60"
                          : "text-muted-foreground",
                      )}
                    >
                      {formatTime(msg.createdAt)}
                    </p>
                  </div>
                </div>
              ))}

            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="shrink-0 border-t bg-card/60 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Steward anything about your environment..."
              className="min-h-[44px] max-h-[160px] resize-none"
              rows={1}
              disabled={sending || enabledProviders.length === 0}
            />
            <Button
              onClick={() => void handleSend()}
              disabled={sending || !input.trim() || enabledProviders.length === 0}
              size="icon"
              className="h-[44px] w-[44px] shrink-0"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}

export default ChatWorkspace;
