"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  Send,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSteward } from "@/lib/hooks/use-steward";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type { LLMProvider } from "@/lib/state/types";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider?: string;
  timestamp: Date;
  error?: boolean;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ChatPage() {
  const { sendChat, providerConfigs, loading: contextLoading } = useSteward();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>("openai");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const enabledProviders = providerConfigs.filter((config) => config.enabled);

  // Determine the active model name for the selected provider
  const activeConfig = providerConfigs.find((c) => c.provider === selectedProvider);
  const activeModel = activeConfig?.model ?? "default";

  useEffect(() => {
    if (enabledProviders.length === 0) {
      return;
    }

    const selectedStillEnabled = enabledProviders.some(
      (config) => config.provider === selectedProvider,
    );
    if (!selectedStillEnabled) {
      setSelectedProvider(enabledProviders[0].provider);
    }
  }, [enabledProviders, selectedProvider]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, sending]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending || enabledProviders.length === 0) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);

    // Re-focus the textarea
    setTimeout(() => textareaRef.current?.focus(), 0);

    try {
      const result = await sendChat(trimmed, selectedProvider);
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.response,
        provider: result.provider,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      const errorMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: err instanceof Error ? err.message : "An unexpected error occurred.",
        provider: selectedProvider,
        timestamp: new Date(),
        error: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setSending(false);
    }
  }, [enabledProviders.length, input, sending, sendChat, selectedProvider]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-var(--shell-offset,0px))] flex-col md:-mx-6 lg:-mx-8">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b bg-card/60 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <h1 className="text-sm font-semibold">Chat with Steward</h1>
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
        {messages.length === 0 && !contextLoading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="rounded-full bg-primary/10 p-4">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Start a conversation</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Ask Steward about your network, diagnose issues, or request remediation actions.
            </p>
          </div>
        )}

        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex gap-3",
                msg.role === "user" ? "flex-row-reverse" : "flex-row",
              )}
            >
              {/* Avatar */}
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

              {/* Bubble */}
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
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</p>
                <p
                  className={cn(
                    "mt-1.5 text-[10px]",
                    msg.role === "user"
                      ? "text-primary-foreground/60"
                      : "text-muted-foreground",
                  )}
                >
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {sending && (
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Bot className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-2 rounded-2xl border bg-card px-4 py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Steward is thinking...</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t bg-card/60 px-4 py-3 backdrop-blur md:px-6">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
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
        <p className="mx-auto mt-1.5 max-w-3xl text-[10px] text-muted-foreground">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
