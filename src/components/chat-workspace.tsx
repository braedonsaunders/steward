"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Globe,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Send,
  Server,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatRuntime, type ChatMessageRecord, type ChatSessionRecord } from "@/lib/hooks/use-chat-runtime";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildOnboardingKickoffPrompt } from "@/lib/adoption/kickoff";
import { PROVIDER_REGISTRY } from "@/lib/llm/registry";
import type {
  ChatToolEvent,
  ChatToolEventKind,
  Device,
  LLMProvider,
} from "@/lib/state/types";
import { getDeviceAttachedChatBlockReason } from "@/lib/state/device-adoption";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

export interface ChatWorkspaceProps {
  initialDeviceId?: string;
  autostart?: boolean;
  respectUrlParams?: boolean;
  compact?: boolean;
  sessionRefreshToken?: number;
  preferredSessionId?: string;
  sessionScope?: "all" | "device";
}

type ChatMessage = ChatMessageRecord;
type ChatSession = ChatSessionRecord;

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

function normalizeToolOutput(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.replace(/^\n+/, "").trimEnd();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function buildCollapsedToolOutputPreview(
  value: string,
  maxLines = 2,
  maxChars = 220,
): { text: string; truncated: boolean } {
  const normalized = normalizeToolOutput(value);
  if (!normalized) {
    return { text: "", truncated: false };
  }

  const lines = normalized.split(/\r?\n/);
  const limitedLines = lines.slice(0, maxLines);
  let preview = limitedLines.join("\n");
  let truncated = lines.length > maxLines;

  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars).trimEnd();
    truncated = true;
  }

  if (truncated) {
    preview = `${preview}…`;
  }

  return { text: preview, truncated };
}

type ExpandableToolOutputPanelProps = {
  title: string;
  value: string;
  terminal?: boolean;
};

const ExpandableToolOutputPanel = memo(function ExpandableToolOutputPanel({
  title,
  value,
  terminal = false,
}: ExpandableToolOutputPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => buildCollapsedToolOutputPreview(value), [value]);
  const displayValue = expanded || !preview.truncated ? value : preview.text;

  if (terminal) {
    return (
      <div className="relative mt-3 overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-950 text-slate-100 shadow-inner">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-slate-900/95 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-rose-400" />
            <span className="h-2 w-2 rounded-full bg-amber-300" />
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.22em] text-slate-400">
              <SquareTerminal className="h-3 w-3" />
              {title}
            </span>
          </div>
          {preview.truncated ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px] uppercase tracking-[0.14em] text-slate-300 hover:bg-white/10 hover:text-slate-100"
              onClick={() => setExpanded((current) => !current)}
            >
              <ArrowDown className={cn("mr-1 h-3 w-3 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Collapse" : "Expand"}
            </Button>
          ) : null}
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-5 text-slate-100/95">
          {displayValue}
        </pre>
      </div>
    );
  }

  return (
    <div className="relative mt-3 rounded-2xl border border-border/60 bg-background/70 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {title}
        </p>
        {preview.truncated ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[10px] uppercase tracking-[0.14em]"
            onClick={() => setExpanded((current) => !current)}
          >
            <ArrowDown className={cn("mr-1 h-3 w-3 transition-transform", expanded && "rotate-180")} />
            {expanded ? "Collapse" : "Expand"}
          </Button>
        ) : null}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/90">
        {displayValue}
      </pre>
    </div>
  );
});

function toolKindLabel(kind: ChatToolEventKind): string {
  switch (kind) {
    case "terminal":
      return "Terminal";
    case "probe":
      return "Probe";
    default:
      return "Tool";
  }
}

function ToolKindIcon({ kind, className }: { kind: ChatToolEventKind; className?: string }) {
  if (kind === "terminal") {
    return <SquareTerminal className={className} />;
  }
  if (kind === "probe") {
    return <Radar className={className} />;
  }
  return <Sparkles className={className} />;
}

function ToolStatusIcon({
  status,
  className,
}: {
  status: ChatToolEvent["status"];
  className?: string;
}) {
  if (status === "failed") {
    return <AlertTriangle className={className} />;
  }
  if (status === "completed") {
    return <CheckCircle2 className={className} />;
  }
  return <Activity className={className} />;
}

type ToolInputPill = {
  label: string;
  value: string;
};

type BrowserStepPreview = {
  action: string;
  ok: boolean;
  label?: string;
  path?: string;
  selector?: string;
  url?: string;
  text?: string;
  result?: string;
  screenshotBase64?: string;
  mimeType?: string;
};

type BrowserToolPreview = {
  ok: boolean;
  url?: string;
  finalUrl?: string;
  title?: string;
  contentPreview?: string;
  stepsExecuted: number;
  stepResults: BrowserStepPreview[];
  diagnostics?: {
    consoleErrors: string[];
    requestFailures: string[];
    pageErrors: string[];
  };
};

type DeviceSettingsToolPreview = {
  changedFields: string[];
  previousName?: string;
  nextName?: string;
  previousType?: string;
  nextType?: string;
  inferredName?: boolean;
  inferredType?: boolean;
};

type AssistantMessageBlock =
  | {
      type: "text";
      id: string;
      content: string;
    }
  | {
      type: "tool-strip";
      id: string;
      events: ChatToolEvent[];
    };

function truncateInlineValue(value: string, maxChars = 72): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeToolInputValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? truncateInlineValue(trimmed, 80) : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "empty";
    }

    const compact = value
      .filter((entry) => ["string", "number", "boolean"].includes(typeof entry))
      .slice(0, 3)
      .map((entry) => String(entry))
      .join(", ");
    if (compact.length > 0 && value.length <= 3) {
      return truncateInlineValue(compact, 60);
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }

  if (typeof value === "object" && value !== null) {
    const fieldCount = Object.keys(value).length;
    return `${fieldCount} field${fieldCount === 1 ? "" : "s"}`;
  }

  return undefined;
}

function extractToolInputPills(inputPreview?: string): ToolInputPill[] {
  const trimmed = inputPreview?.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .map(([label, value]) => {
          const summary = summarizeToolInputValue(value);
          return summary ? { label, value: summary } : null;
        })
        .filter((pill): pill is ToolInputPill => pill !== null)
        .slice(0, 8);
    }

    const summary = summarizeToolInputValue(parsed);
    return summary ? [{ label: "input", value: summary }] : [];
  } catch {
    const jsonLikeMatches = Array.from(
      trimmed.matchAll(/"([^"]+)":\s*("[^"]*"|true|false|null|-?\d+(?:\.\d+)?)/g),
    );
    if (jsonLikeMatches.length > 0) {
      return jsonLikeMatches.slice(0, 8).map((match) => ({
        label: match[1],
        value: truncateInlineValue(match[2].replace(/^"|"$/g, ""), 80),
      }));
    }
  }

  return [{ label: "input", value: truncateInlineValue(trimmed.replace(/\s+/g, " "), 96) }];
}

function parseBrowserToolPreview(event: ChatToolEvent): BrowserToolPreview | null {
  if (event.toolName !== "steward_browser_browse") {
    return null;
  }
  if (!event.outputPreview) {
    return null;
  }

  try {
    const parsed = JSON.parse(event.outputPreview) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const stepResults = Array.isArray(record.stepResults)
      ? record.stepResults
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => ({
          action: typeof item.action === "string" ? item.action : "step",
          ok: item.ok !== false,
          label: typeof item.label === "string" ? item.label : undefined,
          path: typeof item.path === "string" ? item.path : undefined,
          selector: typeof item.selector === "string" ? item.selector : undefined,
          url: typeof item.url === "string" ? item.url : undefined,
          text: typeof item.text === "string" ? item.text : undefined,
          result: typeof item.result === "string" ? item.result : undefined,
          screenshotBase64: typeof item.screenshotBase64 === "string" ? item.screenshotBase64 : undefined,
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
        }))
      : [];

    const diagnosticsRecord = (
      typeof record.diagnostics === "object"
      && record.diagnostics !== null
      && !Array.isArray(record.diagnostics)
    )
      ? record.diagnostics as Record<string, unknown>
      : null;

    const toStringArray = (value: unknown): string[] => (
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 12)
        : []
    );

    return {
      ok: record.ok !== false,
      url: typeof record.url === "string" ? record.url : undefined,
      finalUrl: typeof record.finalUrl === "string" ? record.finalUrl : undefined,
      title: typeof record.title === "string" ? record.title : undefined,
      contentPreview: typeof record.contentPreview === "string" ? record.contentPreview : undefined,
      stepsExecuted: typeof record.stepsExecuted === "number"
        ? record.stepsExecuted
        : stepResults.length,
      stepResults: stepResults.slice(0, 16),
      diagnostics: diagnosticsRecord
        ? {
          consoleErrors: toStringArray(diagnosticsRecord.consoleErrors),
          requestFailures: toStringArray(diagnosticsRecord.requestFailures),
          pageErrors: toStringArray(diagnosticsRecord.pageErrors),
        }
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseDeviceSettingsToolPreview(event: ChatToolEvent): DeviceSettingsToolPreview | null {
  if (event.toolName !== "steward_manage_device") {
    return null;
  }
  if (!event.outputPreview) {
    return null;
  }

  try {
    const parsed = JSON.parse(event.outputPreview) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;

    const changedFields = Array.isArray(record.changedFields)
      ? record.changedFields.filter((value): value is string => typeof value === "string")
      : Array.isArray(record.changes)
        ? record.changes
          .filter((value): value is string => typeof value === "string")
          .map((value) => {
            const match = value.match(/^\s*([a-zA-Z]+)\s*->/);
            return match?.[1] ? match[1] : value;
          })
        : [];

    return {
      changedFields,
      previousName: typeof record.previousName === "string" ? record.previousName : undefined,
      nextName: typeof record.nextName === "string"
        ? record.nextName
        : typeof record.name === "string"
          ? record.name
          : undefined,
      previousType: typeof record.previousType === "string"
        ? record.previousType
        : typeof record.previousCategory === "string"
          ? record.previousCategory
          : undefined,
      nextType: typeof record.nextType === "string"
        ? record.nextType
        : typeof record.category === "string"
          ? record.category
          : undefined,
      inferredName: record.inferredName === true,
      inferredType: record.inferredType === true || record.inferredCategory === true,
    };
  } catch {
    return null;
  }
}

function browserStepScreenshotSrc(step: BrowserStepPreview | undefined): string | null {
  if (!step) {
    return null;
  }
  if (step.screenshotBase64 && step.screenshotBase64.length > 0) {
    return `data:${step.mimeType ?? "image/png"};base64,${step.screenshotBase64}`;
  }
  if (step.path && step.path.length > 0) {
    return `/api/chat/artifacts?path=${encodeURIComponent(step.path)}`;
  }
  return null;
}

function clampAnchorOffset(anchorOffset: number | undefined, contentLength: number): number {
  if (!Number.isFinite(anchorOffset)) {
    return contentLength;
  }

  return Math.max(0, Math.min(contentLength, Math.floor(anchorOffset ?? contentLength)));
}

function preferredLeadingToolOffset(content: string): number {
  const paragraphBreak = content.indexOf("\n\n");
  if (paragraphBreak >= 0) {
    return paragraphBreak + 2;
  }

  const lineBreak = content.indexOf("\n");
  if (lineBreak >= 0) {
    return lineBreak + 1;
  }

  const sentenceMatch = content.slice(0, 220).match(/^.*?[.!?](?:\s|$)/);
  if (sentenceMatch?.[0]) {
    return sentenceMatch[0].length;
  }

  return Math.min(content.length, 220);
}

function buildAssistantBlocks(content: string, toolEvents: ChatToolEvent[]): AssistantMessageBlock[] {
  if (toolEvents.length === 0) {
    return content ? [{ type: "text", id: "text-0", content }] : [];
  }

  let orderedEvents = toolEvents
    .map((event, index) => ({
      event,
      index,
      anchorOffset: clampAnchorOffset(event.anchorOffset, content.length),
    }))
    .sort((left, right) => left.anchorOffset - right.anchorOffset || left.index - right.index);

  if (content.length > 0) {
    const firstNonLeadingIndex = orderedEvents.findIndex((item) => item.anchorOffset > 0);
    const leadingCount = firstNonLeadingIndex === -1 ? orderedEvents.length : firstNonLeadingIndex;
    if (leadingCount > 0) {
      const nextAnchor = firstNonLeadingIndex === -1
        ? content.length
        : orderedEvents[firstNonLeadingIndex].anchorOffset;
      const adjustedAnchor = Math.min(preferredLeadingToolOffset(content), nextAnchor);
      orderedEvents = orderedEvents.map((item, index) => (
        index < leadingCount ? { ...item, anchorOffset: adjustedAnchor } : item
      ));
    }
  }

  const blocks: AssistantMessageBlock[] = [];
  let cursor = 0;
  let pendingAnchor: number | null = null;
  let pendingEvents: ChatToolEvent[] = [];

  const flushPending = () => {
    if (pendingEvents.length === 0) {
      return;
    }

    blocks.push({
      type: "tool-strip",
      id: `tools-${pendingAnchor ?? cursor}-${pendingEvents.map((event) => event.id).join("-")}`,
      events: pendingEvents,
    });
    pendingAnchor = null;
    pendingEvents = [];
  };

  for (const { event, anchorOffset } of orderedEvents) {
    if (pendingAnchor !== null && anchorOffset !== pendingAnchor) {
      flushPending();
    }

    if (anchorOffset > cursor) {
      flushPending();
      const segment = content.slice(cursor, anchorOffset);
      if (segment) {
        blocks.push({
          type: "text",
          id: `text-${cursor}-${anchorOffset}`,
          content: segment,
        });
      }
      cursor = anchorOffset;
    }

    pendingAnchor = anchorOffset;
    pendingEvents.push(event);
  }

  flushPending();

  const remainder = content.slice(cursor);
  if (remainder) {
    blocks.push({
      type: "text",
      id: `text-${cursor}-${content.length}`,
      content: remainder,
    });
  }

  return blocks;
}

const markdownComponents = {
  p: ({ children }: { children?: ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-muted/50 px-1 py-0.5 text-xs">{children}</code>,
  pre: ({ children }: { children?: ReactNode }) => <pre className="mb-2 overflow-x-auto rounded bg-muted/50 p-2 text-xs">{children}</pre>,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="mb-2 w-full overflow-x-auto rounded-md border border-border/70">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: ReactNode }) => <thead className="bg-muted/40">{children}</thead>,
  tbody: ({ children }: { children?: ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: ReactNode }) => <tr className="border-b border-border/60">{children}</tr>,
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border-r border-border/60 px-3 py-2 text-left font-semibold last:border-r-0">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border-r border-border/60 px-3 py-2 align-top last:border-r-0">{children}</td>
  ),
};

const MarkdownMessageContent = memo(function MarkdownMessageContent({ content }: { content: string }) {
  if (!content) {
    return null;
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

const ChatToolInputPills = memo(function ChatToolInputPills({ pills }: { pills: ToolInputPill[] }) {
  if (pills.length === 0) {
    return null;
  }

  return (
    <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
      <span className="pr-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Input
      </span>
      {pills.map((pill) => (
        <span
          key={`${pill.label}-${pill.value}`}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-[11px] leading-none shadow-sm"
        >
          <span className="shrink-0 text-muted-foreground">{pill.label}</span>
          <span className="truncate font-medium text-foreground">{pill.value}</span>
        </span>
      ))}
    </div>
  );
});

const ChatToolEventCard = memo(function ChatToolEventCard({
  event,
  live,
}: {
  event: ChatToolEvent;
  live: boolean;
}) {
  const running = event.status === "running";
  const normalizedOutput = normalizeToolOutput(event.outputPreview);
  const browserPreview = parseBrowserToolPreview(event);
  const deviceSettingsPreview = parseDeviceSettingsToolPreview(event);
  const inputPills = useMemo(() => extractToolInputPills(event.inputPreview), [event.inputPreview]);
  const browserScreenshotStep = browserPreview?.stepResults.find((step) => step.screenshotBase64 || step.path);
  const browserScreenshotSrc = browserStepScreenshotSrc(browserScreenshotStep);
  const standardCard = !browserPreview && !deviceSettingsPreview;
  const hasLongSummary = Boolean(
    (event.error && (event.error.length > 140 || event.error.includes("\n")))
    || (event.summary && (event.summary.length > 140 || event.summary.includes("\n"))),
  );
  const hasExpandableDetails = standardCard && (inputPills.length > 0 || Boolean(normalizedOutput) || hasLongSummary);
  const [expanded, setExpanded] = useState(false);
  const detailSummary = useMemo(() => {
    const parts: string[] = [];

    if (inputPills.length > 0) {
      parts.push(`${inputPills.length} input${inputPills.length === 1 ? "" : "s"}`);
    }

    if (normalizedOutput) {
      parts.push(event.kind === "terminal" ? "terminal output" : "output");
    }

    if (running && parts.length === 0) {
      parts.push("live");
    }

    return parts.join(" · ");
  }, [event.kind, inputPills.length, normalizedOutput, running]);
  const showDetails = !standardCard || expanded;
  const accentClasses = event.status === "failed"
    ? "border-rose-500/25 bg-[radial-gradient(circle_at_top_left,rgba(244,63,94,0.14),transparent_60%)]"
    : running
      ? "border-sky-500/25 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_62%)]"
      : "border-emerald-500/25 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_62%)]";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card/90 px-3 py-2.5 shadow-[0_14px_35px_-24px_rgba(15,23,42,0.45)] backdrop-blur",
        accentClasses,
      )}
    >
      {running && live && (
        <>
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(118deg,transparent,rgba(255,255,255,0.2),transparent)]"
            animate={{ x: ["-120%", "120%"] }}
            transition={{ duration: 1.9, repeat: Infinity, ease: "linear" }}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute right-4 top-3 h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.9)]"
            animate={{ opacity: [0.35, 1, 0.35], scale: [0.9, 1.15, 0.9] }}
            transition={{ duration: 1.15, repeat: Infinity, ease: "easeInOut" }}
          />
        </>
      )}

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-background/80 shadow-inner">
              <ToolKindIcon kind={event.kind} className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold text-foreground">{event.label}</p>
              <p className="text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                {toolKindLabel(event.kind)}
              </p>
            </div>
          </div>

          {(event.summary || event.error || detailSummary) && (
            <div className="mt-1.5 space-y-1">
              {(event.summary || event.error) ? (
                <p
                  className={cn(
                    "text-[12px] leading-5",
                    event.error ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground",
                    standardCard && !expanded && "line-clamp-2",
                  )}
                >
                  {event.error ?? event.summary}
                </p>
              ) : null}
              {standardCard && !expanded && detailSummary ? (
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {detailSummary}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
              event.status === "failed"
                ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                : running
                  ? "bg-sky-500/12 text-sky-600 dark:text-sky-300"
                  : "bg-emerald-500/12 text-emerald-600 dark:text-emerald-300",
            )}
          >
            <ToolStatusIcon status={event.status} className={cn("h-3 w-3", running && "animate-pulse")} />
            {event.status === "failed" ? "Failed" : running ? "Running" : "Complete"}
          </div>

          {hasExpandableDetails ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${event.label} details` : `Expand ${event.label} details`}
              className="h-7 rounded-full px-2 text-[10px] uppercase tracking-[0.14em]"
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Hide" : "Details"}
            </Button>
          ) : null}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showDetails ? (
          <motion.div
            key="details"
            initial={standardCard ? { height: 0, opacity: 0 } : false}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-3">
              <ChatToolInputPills pills={inputPills} />

              {browserPreview && (
                <div className="space-y-2 rounded-2xl border border-border/60 bg-background/70 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    {browserPreview.title ? <Badge variant="outline">{browserPreview.title}</Badge> : null}
                    <Badge variant="secondary">{browserPreview.stepsExecuted} step{browserPreview.stepsExecuted === 1 ? "" : "s"}</Badge>
                    {browserPreview.finalUrl ? <span className="truncate text-muted-foreground">{browserPreview.finalUrl}</span> : null}
                  </div>

                  {browserScreenshotSrc ? (
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
                      <img
                        src={browserScreenshotSrc}
                        alt="Browser snapshot"
                        className="mx-auto h-auto max-h-[34rem] w-full object-contain"
                      />
                    </div>
                  ) : null}

                  {browserPreview.contentPreview ? (
                    <p className="line-clamp-4 text-[12px] leading-5 text-muted-foreground">{browserPreview.contentPreview}</p>
                  ) : null}

                  {browserPreview.stepResults.length > 0 ? (
                    <div className="space-y-1.5">
                      {browserPreview.stepResults.map((step, index) => (
                        <div key={`${step.action}-${index}`} className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{step.label ?? step.action}</p>
                            <p className="truncate text-muted-foreground">{step.selector ?? step.url ?? step.text ?? step.result ?? ""}</p>
                          </div>
                          <Badge variant={step.ok ? "secondary" : "outline"}>{step.ok ? "ok" : "failed"}</Badge>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {browserPreview.diagnostics && (
                    <div className="grid gap-2 text-[11px] sm:grid-cols-3">
                      <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5">
                        <p className="font-medium">Console</p>
                        <p className="text-muted-foreground">{browserPreview.diagnostics.consoleErrors.length} issue{browserPreview.diagnostics.consoleErrors.length === 1 ? "" : "s"}</p>
                      </div>
                      <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5">
                        <p className="font-medium">Requests</p>
                        <p className="text-muted-foreground">{browserPreview.diagnostics.requestFailures.length} failed</p>
                      </div>
                      <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5">
                        <p className="font-medium">Page Errors</p>
                        <p className="text-muted-foreground">{browserPreview.diagnostics.pageErrors.length}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {deviceSettingsPreview && (
                <div className="space-y-2 rounded-2xl border border-border/60 bg-background/70 p-3 text-[12px]">
                  <div className="flex flex-wrap gap-1.5">
                    {deviceSettingsPreview.changedFields.length > 0
                      ? deviceSettingsPreview.changedFields.map((field) => (
                        <Badge key={field} variant="secondary">{field}</Badge>
                      ))
                      : <Badge variant="outline">no changes</Badge>}
                  </div>
                  {(deviceSettingsPreview.previousName || deviceSettingsPreview.nextName) && (
                    <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Name</p>
                      <p className="font-medium text-foreground">
                        {deviceSettingsPreview.previousName ?? "-"} -&gt; {deviceSettingsPreview.nextName ?? "-"}
                      </p>
                      {deviceSettingsPreview.inferredName ? (
                        <p className="text-[11px] text-muted-foreground">Auto-inferred from known identity</p>
                      ) : null}
                    </div>
                  )}
                  {(deviceSettingsPreview.previousType || deviceSettingsPreview.nextType) && (
                    <div className="rounded-md border border-border/60 bg-background/80 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Category</p>
                      <p className="font-medium text-foreground">
                        {deviceSettingsPreview.previousType ?? "-"} -&gt; {deviceSettingsPreview.nextType ?? "-"}
                      </p>
                      {deviceSettingsPreview.inferredType ? (
                        <p className="text-[11px] text-muted-foreground">Auto-inferred from known identity</p>
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              {normalizedOutput && event.kind === "terminal" && (
                <ExpandableToolOutputPanel title="Inline Terminal" value={normalizedOutput} terminal />
              )}

              {normalizedOutput && event.kind !== "terminal" && (
                <ExpandableToolOutputPanel title="Tool Output" value={normalizedOutput} />
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
});

const ChatToolEventStrip = memo(function ChatToolEventStrip({
  events,
  live,
}: {
  events: ChatToolEvent[];
  live: boolean;
}) {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {events.map((event) => (
          <ChatToolEventCard key={event.id} event={event} live={live} />
        ))}
      </AnimatePresence>
    </div>
  );
});

const ChatMessageBubble = memo(function ChatMessageBubble({ msg }: { msg: ChatMessage }) {
  const rawToolEvents = msg.metadata?.toolEvents;
  const toolEvents = useMemo(() => rawToolEvents ?? [], [rawToolEvents]);
  const showWidgets = msg.role === "assistant" && toolEvents.length > 0;
  const messageContent = msg.content || (msg.streaming ? "Steward is working..." : "");
  const orderedBlocks = useMemo(
    () => (msg.role === "assistant" ? buildAssistantBlocks(messageContent, toolEvents) : []),
    [messageContent, msg.role, toolEvents],
  );

  return (
    <div
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
        {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5",
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
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">Error</p>
        )}

        <div className="space-y-3 text-sm leading-relaxed">
          {showWidgets
            ? orderedBlocks.map((block) => (
              block.type === "text" ? (
                <MarkdownMessageContent key={block.id} content={block.content} />
              ) : (
                <ChatToolEventStrip key={block.id} events={block.events} live={Boolean(msg.streaming)} />
              )
            ))
            : (
              <MarkdownMessageContent content={messageContent} />
            )}
          {msg.streaming && (
            <span className="mt-2 inline-flex items-center gap-1.5 align-middle text-xs text-muted-foreground">
              <Globe className="h-3 w-3" />
              <Loader2 className="h-3 w-3 animate-spin" />
              live
            </span>
          )}
        </div>
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
  );
});

function getDeviceChatBlockReason(
  device: Device,
): string | null {
  return getDeviceAttachedChatBlockReason(device);
}

function isOnboardingChatSession(session: ChatSession | undefined): boolean {
  return Boolean(session?.title?.startsWith("[Onboarding]"));
}

export function ChatWorkspace({
  initialDeviceId,
  autostart,
  respectUrlParams = true,
  compact = false,
  sessionRefreshToken,
  preferredSessionId,
  sessionScope = "all",
}: ChatWorkspaceProps = {}) {
  const { devices, providerConfigs, loading: contextLoading } = useSteward();
  const {
    sessions,
    sessionsLoading,
    sending,
    sendStartedAt,
    streamingSessionId,
    refreshSessions,
    isSessionLoaded,
    isSessionLoading,
    getSessionMessages,
    loadSessionMessages,
    createSession,
    deleteSession,
    renameSession,
    sendMessage: sendRuntimeMessage,
    stopStreaming,
  } = useChatRuntime();
  const searchParams = useSearchParams();

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Chat input
  const [input, setInput] = useState("");
  const [sendElapsedMs, setSendElapsedMs] = useState(0);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<LLMProvider>("openai");

  // UI
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newChatDeviceId, setNewChatDeviceId] = useState<string>(sessionScope === "device" && initialDeviceId ? initialDeviceId : "__none__");
  const [groupBy, setGroupBy] = useState<"recent" | "device">("recent");

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const deepLinkAppliedRef = useRef(false);
  const onboardingKickoffAttemptedRef = useRef<Set<string>>(new Set());
  const pendingPreferredSessionIdRef = useRef<string | null>(null);
  const enabledProviders = providerConfigs.filter((config) => config.enabled);
  const deviceById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const requestedDeviceId = initialDeviceId
    ?? (respectUrlParams ? searchParams.get("deviceId") : null);
  const scopedDeviceId = sessionScope === "device" ? initialDeviceId ?? undefined : undefined;
  const deviceScoped = Boolean(scopedDeviceId);
  const autostartParam = respectUrlParams ? searchParams.get("autostart") : null;
  const urlAutostart = autostartParam === null ? false : autostartParam !== "0";
  const shouldAutostart = autostart ?? urlAutostart;
  const composerDeviceId = deviceScoped ? (scopedDeviceId ?? "__none__") : newChatDeviceId;
  const pendingSessionDeviceId = deviceScoped
    ? scopedDeviceId
    : composerDeviceId === "__none__"
      ? undefined
      : composerDeviceId;
  const visibleSessions = useMemo(
    () => (
      scopedDeviceId
        ? sessions.filter((session) => session.deviceId === scopedDeviceId)
        : sessions
    ),
    [scopedDeviceId, sessions],
  );

  const effectiveSelectedProvider = enabledProviders.some((config) => config.provider === selectedProvider)
    ? selectedProvider
    : enabledProviders[0]?.provider ?? selectedProvider;
  const activeConfig = providerConfigs.find((c) => c.provider === effectiveSelectedProvider);
  const activeModel = activeConfig?.model ?? "default";
  const activeSession = visibleSessions.find((session) => session.id === activeSessionId);
  const messages = useMemo(
    () => getSessionMessages(activeSessionId),
    [activeSessionId, getSessionMessages],
  );
  const messagesLoading = activeSessionId ? isSessionLoading(activeSessionId) : false;
  const activeSessionLoaded = activeSessionId ? isSessionLoaded(activeSessionId) : false;
  const activeSessionIsStreaming = activeSessionId !== null && streamingSessionId === activeSessionId;
  const sendElapsedSec = Math.max(0, Math.floor(sendElapsedMs / 1000));
  const activeSessionDevice = activeSession?.deviceId
    ? deviceById.get(activeSession.deviceId)
    : undefined;
  const selectedDevice = composerDeviceId !== "__none__"
    ? deviceById.get(composerDeviceId)
    : undefined;
  const activeSessionBlockReason = activeSessionDevice
    ? getDeviceChatBlockReason(activeSessionDevice)
    : null;
  const selectedDeviceBlockReason = selectedDevice
    ? getDeviceChatBlockReason(selectedDevice)
    : null;
  const chatBlockReason = activeSessionDevice
    ? (isOnboardingChatSession(activeSession) ? null : activeSessionBlockReason)
    : selectedDeviceBlockReason;
  const blockedDevice = activeSessionDevice ?? selectedDevice;

  const groupedSessions = useMemo(() => {
    if (deviceScoped) {
      return [{
        key: scopedDeviceId ?? "device",
        label: scopedDeviceId ? deviceById.get(scopedDeviceId)?.name ?? "Current device" : "Current device",
        sessions: visibleSessions,
      }];
    }

    if (groupBy === "recent") {
      return [{ key: "recent", label: "Recent", sessions: visibleSessions }];
    }

    const bucket = new Map<string, ChatSession[]>();
    const unassigned: ChatSession[] = [];

    for (const session of visibleSessions) {
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
  }, [deviceById, deviceScoped, groupBy, scopedDeviceId, visibleSessions]);

  const selectSession = useCallback((sessionId: string | null) => {
    setActiveSessionId(sessionId);
    setStickToBottom(true);
  }, []);

  const applyRequestedDeviceSelection = useCallback((deviceId: string) => {
    setNewChatDeviceId(deviceId);
    if (!deviceScoped) {
      setGroupBy("device");
    }
  }, [deviceScoped]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const syncSidebarMode = () => setSidebarOpen(!query.matches);
    syncSidebarMode();
    query.addEventListener("change", syncSidebarMode);
    return () => query.removeEventListener("change", syncSidebarMode);
  }, []);

  useEffect(() => {
    if (sessionRefreshToken === undefined) return;
    void refreshSessions();
  }, [sessionRefreshToken, refreshSessions]);

  useEffect(() => {
    const pendingPreferredSessionId = preferredSessionId ?? null;
    pendingPreferredSessionIdRef.current = pendingPreferredSessionId;
    if (!pendingPreferredSessionId) return;

    const preferredTimer = window.setTimeout(() => {
      selectSession(pendingPreferredSessionId);
      void loadSessionMessages(pendingPreferredSessionId);
      void refreshSessions();
    }, 0);
    return () => window.clearTimeout(preferredTimer);
  }, [loadSessionMessages, preferredSessionId, refreshSessions, selectSession]);

  useEffect(() => {
    const pendingPreferredSessionId = pendingPreferredSessionIdRef.current;
    if (!pendingPreferredSessionId) return;
    if (!visibleSessions.some((session) => session.id === pendingPreferredSessionId)) return;
    pendingPreferredSessionIdRef.current = null;
  }, [visibleSessions]);

  useEffect(() => {
    if (!deviceScoped) return;
    if (activeSessionId) return;
    if (sessionsLoading) return;
    if (preferredSessionId) return;
    if (visibleSessions.length === 0) return;

    const initialSessionTimer = window.setTimeout(() => {
      selectSession(visibleSessions[0]?.id ?? null);
    }, 0);
    return () => window.clearTimeout(initialSessionTimer);
  }, [activeSessionId, deviceScoped, preferredSessionId, selectSession, sessionsLoading, visibleSessions]);

  useEffect(() => {
    if (activeSessionId) return;
    if (!streamingSessionId) return;
    if (!visibleSessions.some((session) => session.id === streamingSessionId)) return;

    const streamingTimer = window.setTimeout(() => {
      selectSession(streamingSessionId);
    }, 0);
    return () => window.clearTimeout(streamingTimer);
  }, [activeSessionId, selectSession, streamingSessionId, visibleSessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (visibleSessions.some((session) => session.id === activeSessionId)) return;
    if (sessionsLoading) return;
    if (preferredSessionId && activeSessionId === preferredSessionId) return;
    const fallbackTimer = window.setTimeout(() => {
      selectSession(visibleSessions[0]?.id ?? null);
    }, 0);
    return () => window.clearTimeout(fallbackTimer);
  }, [activeSessionId, preferredSessionId, selectSession, sessionsLoading, visibleSessions]);

  useEffect(() => {
    if (!activeSessionId) return;
    if (activeSessionLoaded) return;
    if (messagesLoading) return;
    void loadSessionMessages(activeSessionId);
  }, [activeSessionId, activeSessionLoaded, loadSessionMessages, messagesLoading]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, activeSessionIsStreaming, stickToBottom]);

  useEffect(() => {
    if (!sending || !sendStartedAt) {
      const resetTimer = window.setTimeout(() => {
        setSendElapsedMs(0);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    const syncElapsed = () => {
      setSendElapsedMs(Math.max(0, Date.now() - sendStartedAt));
    };
    const initialTimer = window.setTimeout(syncElapsed, 0);
    const timer = setInterval(() => {
      syncElapsed();
    }, 1000);
    return () => {
      window.clearTimeout(initialTimer);
      clearInterval(timer);
    };
  }, [sendStartedAt, sending]);

  const handleCreateSession = useCallback(async (deviceId?: string) => {
    const session = await createSession(deviceId);
    if (session) {
      selectSession(session.id);
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
    return session;
  }, [createSession, selectSession]);

  useEffect(() => {
    deepLinkAppliedRef.current = false;
  }, [requestedDeviceId, shouldAutostart]);

  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (!requestedDeviceId) return;
    if (contextLoading || sessionsLoading) return;

    deepLinkAppliedRef.current = true;
    if (!deviceById.has(requestedDeviceId)) return;

    const contextTimer = window.setTimeout(() => {
      applyRequestedDeviceSelection(requestedDeviceId);
    }, 0);

    const matchingSession = visibleSessions.find(
      (session) => session.deviceId === requestedDeviceId && isOnboardingChatSession(session),
    ) ?? visibleSessions.find((session) => session.deviceId === requestedDeviceId);
    if (matchingSession) {
      const sessionTimer = window.setTimeout(() => {
        selectSession(matchingSession.id);
      }, 0);
      return () => {
        window.clearTimeout(contextTimer);
        window.clearTimeout(sessionTimer);
      };
    }

    if (shouldAutostart) {
      const createTimer = window.setTimeout(() => {
        void handleCreateSession(requestedDeviceId);
      }, 0);
      return () => {
        window.clearTimeout(contextTimer);
        window.clearTimeout(createTimer);
      };
    }

    return () => window.clearTimeout(contextTimer);
  }, [
    applyRequestedDeviceSelection,
    contextLoading,
    deviceScoped,
    deviceById,
    handleCreateSession,
    requestedDeviceId,
    selectSession,
    visibleSessions,
    sessionsLoading,
    shouldAutostart,
  ]);

  const promptRenameSession = useCallback((session: ChatSession) => {
    const nextTitle = window.prompt("Rename chat", session.title);
    if (nextTitle === null) return;
    void renameSession(session.id, nextTitle);
  }, [renameSession]);

  const confirmDeleteSession = useCallback((session: ChatSession) => {
    const confirmed = window.confirm(`Delete "${session.title}"? This cannot be undone.`);
    if (!confirmed) return;
    void deleteSession(session.id);
  }, [deleteSession]);

  const jumpToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setStickToBottom(true);
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    if (messagesLoading) return;
    if (!activeSessionLoaded) return;

    const frame = window.requestAnimationFrame(() => {
      jumpToBottom("auto");
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeSessionId, activeSessionLoaded, jumpToBottom, messagesLoading]);

  const sendMessage = useCallback(async (options: {
    text: string;
    suppressUserMessage?: boolean;
    autoTitle?: boolean;
  }): Promise<boolean> => {
    const trimmed = options.text.trim();
    if (!trimmed || sending || enabledProviders.length === 0 || chatBlockReason) return false;

    let sessionId = activeSessionId;
    if (!sessionId) {
      const session = await handleCreateSession(pendingSessionDeviceId);
      if (!session) return false;
      sessionId = session.id;
    }

    setStickToBottom(true);
    const result = await sendRuntimeMessage({
      text: trimmed,
      provider: effectiveSelectedProvider,
      sessionId,
      suppressUserMessage: options.suppressUserMessage,
      autoTitle: options.autoTitle,
    });

    if (result.sessionId && result.sessionId !== sessionId) {
      selectSession(result.sessionId);
    }

    if (result.ok) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }

    return result.ok;
  }, [
    activeSessionId,
    chatBlockReason,
    enabledProviders.length,
    handleCreateSession,
    pendingSessionDeviceId,
    effectiveSelectedProvider,
    sendRuntimeMessage,
    selectSession,
    sending,
  ]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    await sendMessage({
      text: trimmed,
      suppressUserMessage: false,
      autoTitle: true,
    });
  }, [input, sendMessage]);

  useEffect(() => {
    if (!activeSessionId || !activeSession || !isOnboardingChatSession(activeSession)) return;
    if (!activeSessionDevice) return;
    if (!activeSessionLoaded) return;
    if (messagesLoading || sending) return;
    if (messages.length > 0) return;
    if (enabledProviders.length === 0 || chatBlockReason) return;
    if (onboardingKickoffAttemptedRef.current.has(activeSessionId)) return;

    onboardingKickoffAttemptedRef.current.add(activeSessionId);
    const kickoffTimer = window.setTimeout(() => {
      void sendMessage({
        text: buildOnboardingKickoffPrompt(activeSessionDevice),
        suppressUserMessage: true,
        autoTitle: false,
      });
    }, 0);
    return () => window.clearTimeout(kickoffTimer);
  }, [
    activeSession,
    activeSessionDevice,
    activeSessionId,
    activeSessionLoaded,
    chatBlockReason,
    enabledProviders.length,
    messages,
    messagesLoading,
    sendMessage,
    sending,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      if (sending) {
        return;
      }
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 min-w-0 w-full flex-1 overflow-hidden">
      {/* Sidebar */}
      <div
        className={cn(
          "z-30 flex h-full min-w-0 shrink-0 flex-col overflow-x-hidden border-r bg-card/40 transition-all duration-200",
          sidebarOpen
            ? cn(
                "absolute inset-y-0 left-0 md:relative",
                compact ? "w-[min(82vw,300px)] md:w-[248px]" : "w-[min(86vw,320px)] md:w-[268px]",
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
                void handleCreateSession(pendingSessionDeviceId)
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

          {!deviceScoped && (
            <div className={cn("grid gap-2", compact && "gap-1.5")}>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={cn("w-11 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground", compact && "w-10 text-[9px]")}>
                  Device
                </span>
                <Select value={composerDeviceId} onValueChange={setNewChatDeviceId}>
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
          )}
        </div>

        {/* Session list */}
        <ScrollArea className="min-w-0 flex-1 overflow-x-hidden [&>[data-radix-scroll-area-viewport]]:overflow-x-hidden">
          <div className="space-y-0.5 p-2">
            {sessionsLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {!sessionsLoading && visibleSessions.length === 0 && (
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
                        "group flex w-full min-w-0 flex-col items-stretch gap-1.5 rounded-lg px-2 py-2 text-sm transition-colors",
                        activeSessionId === session.id
                          ? "bg-primary/10 text-primary"
                          : "text-foreground/70 hover:bg-muted/50",
                      )}
                    >
                      <button
                        type="button"
                        className="w-full min-w-0 max-w-full overflow-hidden text-left"
                        onClick={() => setActiveSessionId(session.id)}
                        title={session.title}
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
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                          onClick={() => promptRenameSession(session)}
                        >
                          Rename
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-destructive"
                          onClick={() => confirmDeleteSession(session)}
                        >
                          Delete
                        </Button>
                      </div>
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
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b bg-card/60 px-4 py-3 backdrop-blur md:px-6",
            compact && "gap-2 px-3 py-2 md:px-4",
          )}
        >
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 shrink-0", compact && "h-7 w-7")}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen className={cn("h-4 w-4", compact && "h-3.5 w-3.5")} />
            </Button>
          )}
          <div className={cn("flex min-w-0 items-center gap-2", compact && "gap-1.5")}>
            <Bot className={cn("h-5 w-5 text-primary", compact && "h-4 w-4")} />
            <h1
              className={cn("steward-heading-font truncate text-sm font-semibold", compact && "text-[13px]")}
              title={activeSessionId ? activeSession?.title ?? "Chat" : "Chat with Steward"}
            >
              {activeSessionId
                ? activeSession?.title ?? "Chat"
                : "Chat with Steward"}
            </h1>
            {activeSessionDevice && (
              <Badge
                variant="secondary"
                className={cn(
                  "hidden max-w-[220px] items-center gap-1 truncate md:inline-flex",
                  compact && "max-w-[180px] text-[10px]",
                )}
              >
                <Server className={cn("h-3 w-3 shrink-0", compact && "h-2.5 w-2.5")} />
                <span className="truncate">{activeSessionDevice.name}</span>
              </Badge>
            )}
          </div>

          <div className={cn("ml-auto flex items-center gap-3", compact && "gap-2")}>
            {activeSession && (
              deviceScoped ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn("shrink-0", compact && "h-8 px-2 text-[11px]")}
                    onClick={() => promptRenameSession(activeSession)}
                  >
                    <Edit3 className={cn("h-3.5 w-3.5", compact && "h-3 w-3")} />
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      "shrink-0 text-destructive hover:text-destructive",
                      compact && "h-8 px-2 text-[11px]",
                    )}
                    onClick={() => confirmDeleteSession(activeSession)}
                  >
                    <Trash2 className={cn("h-3.5 w-3.5", compact && "h-3 w-3")} />
                    Delete
                  </Button>
                </>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("h-8 w-8 shrink-0", compact && "h-7 w-7")}
                      aria-label={`Manage ${activeSession.title}`}
                    >
                      <MoreHorizontal className={cn("h-4 w-4", compact && "h-3.5 w-3.5")} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onSelect={() => promptRenameSession(activeSession)}>
                      <Edit3 className="mr-2 h-3.5 w-3.5" />
                      Rename chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => confirmDeleteSession(activeSession)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            )}
            <Select
              value={effectiveSelectedProvider}
              onValueChange={(v) => setSelectedProvider(v as LLMProvider)}
              disabled={enabledProviders.length === 0}
            >
              <SelectTrigger className={cn("w-[150px]", compact && "h-8 w-[128px] text-xs")}>
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

            <Badge variant="outline" className={cn("hidden text-xs sm:inline-flex", compact && "text-[10px]")}>
              {activeModel}
            </Badge>
          </div>
        </div>

        {/* Message area */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className={cn(
              "h-full overflow-y-auto px-4 py-4 md:px-6",
              compact && "px-3 py-3 md:px-4",
            )}
            onScroll={(event) => {
              const el = event.currentTarget;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              setStickToBottom(distanceFromBottom <= 80);
            }}
          >
            {chatBlockReason && blockedDevice && (
              <div className="mb-3 rounded-lg border border-amber-200/70 bg-amber-50/80 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
                <p className="font-medium">Attached device chat is gated</p>
                <p className="mt-1 text-xs sm:text-sm">{chatBlockReason}</p>
              </div>
            )}

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
                {pendingSessionDeviceId && deviceById.get(pendingSessionDeviceId) && (
                  <Badge variant="secondary" className="mt-3 inline-flex items-center gap-1">
                    <Server className="h-3 w-3" />
                    Attached: {deviceById.get(pendingSessionDeviceId)?.name}
                  </Badge>
                )}
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() =>
                    void handleCreateSession(pendingSessionDeviceId)
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
              <div className={cn("space-y-4", compact && "space-y-3")}>
                {messages.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Bot className="h-6 w-6 text-muted-foreground" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      Send a message to get started
                    </p>
                  </div>
                )}

                {messages.map((msg) => (
                  <ChatMessageBubble key={msg.id} msg={msg} />
                ))}
              </div>
            )}
          </div>

          <AnimatePresence initial={false}>
            {activeSessionId && messages.length > 0 && !messagesLoading && !stickToBottom && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="pointer-events-none absolute bottom-4 right-4 z-10"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={cn(
                    "pointer-events-auto rounded-full border bg-background/92 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground",
                    compact && "h-8 w-8",
                  )}
                  aria-label="Jump to latest messages"
                  onClick={() => jumpToBottom()}
                >
                  <ArrowDown className={cn("h-4 w-4", compact && "h-3.5 w-3.5")} />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Input bar */}
        <div
          className={cn(
            "shrink-0 border-t bg-card/60 px-4 py-3 backdrop-blur md:px-6",
            compact && "px-3 py-2 md:px-4",
          )}
        >
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Steward anything about your environment..."
              className={cn("min-h-[44px] max-h-[160px] resize-none", compact && "min-h-[40px] max-h-[132px]")}
              rows={1}
              disabled={enabledProviders.length === 0 || Boolean(chatBlockReason)}
            />
            <Button
              type="button"
              variant={sending ? "outline" : "default"}
              onClick={sending ? () => stopStreaming(activeSessionId) : () => void handleSend()}
              disabled={!sending && (!input.trim() || enabledProviders.length === 0 || Boolean(chatBlockReason))}
              size="icon"
              className={cn("h-[44px] w-[44px] shrink-0", compact && "h-[40px] w-[40px]")}
              aria-label={sending ? "Interrupt response" : "Send message"}
            >
              {sending ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className={cn("mt-1.5 text-[10px] text-muted-foreground", compact && "mt-1")}>
            {sending
              ? `Streaming live... ${sendElapsedSec}s elapsed. Press stop to interrupt.`
              : chatBlockReason
                ? "Finish onboarding to enable attached chat actions"
                : "Press Enter to send, Shift+Enter for new line"}
          </p>
        </div>
      </div>
    </div>
  );
}

export default ChatWorkspace;
