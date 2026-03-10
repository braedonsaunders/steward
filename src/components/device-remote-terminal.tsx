"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withClientApiToken } from "@/lib/auth/client-token";
import { cn } from "@/lib/utils";

type TerminalTransport = "ssh" | "winrm" | "powershell-ssh";

interface TerminalBootstrapResponse {
  available: boolean;
  transport?: TerminalTransport;
  transportLabel?: string;
  port?: number;
  reason: string;
  error?: string;
}

interface TerminalRunResponse {
  ok: boolean;
  status: string;
  summary: string;
  output: string;
  cwd?: string;
  transport: TerminalTransport;
  transportLabel: string;
  startedAt: string;
  completedAt: string;
  error?: string;
}

interface TerminalEntry {
  id: string;
  kind: "system" | "command" | "output" | "error";
  text: string;
  prompt?: string;
}

interface DeviceRemoteTerminalProps {
  deviceId: string;
  deviceName: string;
  active?: boolean;
  className?: string;
}

function promptForTransport(transport?: TerminalTransport, cwd?: string): string {
  const location = cwd?.trim().length ? cwd.trim() : transport === "ssh" ? "~" : "PS";
  return transport === "ssh" ? `${location} $` : `${location}>`;
}

function buildBootstrapEntry(payload: TerminalBootstrapResponse): TerminalEntry {
  return {
    id: `bootstrap-${Date.now()}`,
    kind: payload.available ? "system" : "error",
    text: payload.available
      ? `${payload.reason} Type a command and press Enter. Use clear to reset the scrollback.`
      : payload.reason,
  };
}

export function DeviceRemoteTerminal({
  deviceId,
  deviceName,
  active = true,
  className,
}: DeviceRemoteTerminalProps) {
  const [bootstrap, setBootstrap] = useState<TerminalBootstrapResponse | null>(null);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const prompt = useMemo(
    () => promptForTransport(bootstrap?.transport, cwd),
    [bootstrap?.transport, cwd],
  );

  const appendEntry = useCallback((entry: TerminalEntry) => {
    setEntries((current) => [...current, entry]);
  }, []);

  const loadBootstrap = useCallback(async (reset = false) => {
    if (!active) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/remote-terminal`,
        withClientApiToken({ cache: "no-store" }),
      );
      const payload = (await response.json()) as TerminalBootstrapResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to prepare the remote terminal.");
      }
      setBootstrap(payload);
      setEntries((current) => {
        const nextEntry = buildBootstrapEntry(payload);
        return reset ? [nextEntry] : [...current, nextEntry];
      });
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to prepare the remote terminal.";
      setBootstrap({ available: false, reason: message });
      setEntries((current) => reset
        ? [{ id: `bootstrap-error-${Date.now()}`, kind: "error", text: message }]
        : [...current, { id: `bootstrap-error-${Date.now()}`, kind: "error", text: message }]);
    } finally {
      setLoading(false);
    }
  }, [active, deviceId]);

  useEffect(() => {
    setBootstrap(null);
    setEntries([]);
    setCommand("");
    setCwd(undefined);
    setHistory([]);
    setHistoryIndex(null);
    setHistoryDraft("");
  }, [deviceId]);

  useEffect(() => {
    if (!active || bootstrap) {
      return;
    }
    void loadBootstrap(true);
  }, [active, bootstrap, loadBootstrap]);

  useEffect(() => {
    if (!active || !bootstrap?.available || running) {
      return;
    }
    inputRef.current?.focus();
  }, [active, bootstrap?.available, running]);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) {
      return;
    }
    output.scrollTop = output.scrollHeight;
  }, [entries, running]);

  const submitCommand = useCallback(async () => {
    const nextCommand = command.trim();
    if (!bootstrap?.available || running || nextCommand.length === 0) {
      return;
    }

    if (nextCommand === "clear" || nextCommand === "cls") {
      setEntries([]);
      setCommand("");
      setHistoryIndex(null);
      setHistoryDraft("");
      return;
    }

    appendEntry({
      id: `command-${Date.now()}`,
      kind: "command",
      text: command,
      prompt,
    });
    setCommand("");
    setHistoryIndex(null);
    setHistoryDraft("");
    setHistory((current) => {
      if (current[current.length - 1] === command) {
        return current;
      }
      return [...current, command];
    });
    setRunning(true);

    try {
      const response = await fetch(
        `/api/devices/${encodeURIComponent(deviceId)}/remote-terminal`,
        withClientApiToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command,
            ...(cwd ? { cwd } : {}),
          }),
        }),
      );
      const payload = (await response.json()) as TerminalRunResponse | { error?: string };
      if (!response.ok && !("ok" in payload)) {
        throw new Error(payload.error ?? "Remote terminal command failed.");
      }

      if (!("ok" in payload)) {
        throw new Error(payload.error ?? "Remote terminal command failed.");
      }

      setBootstrap((current) => ({
        available: true,
        transport: payload.transport,
        transportLabel: payload.transportLabel,
        port: current?.port,
        reason: current?.reason ?? `Using ${payload.transportLabel}.`,
      }));
      if (payload.cwd?.trim().length) {
        setCwd(payload.cwd.trim());
      }

      const normalizedSummary = payload.summary.trim();
      const normalizedOutput = payload.output.trim();

      if (!payload.ok && normalizedSummary.length > 0 && normalizedSummary !== normalizedOutput) {
        appendEntry({
          id: `summary-${Date.now()}`,
          kind: "error",
          text: normalizedSummary,
        });
      }

      if (normalizedOutput.length > 0) {
        appendEntry({
          id: `output-${Date.now()}`,
          kind: payload.ok ? "output" : "error",
          text: normalizedOutput,
        });
      } else if (payload.ok && normalizedSummary.length > 0) {
        appendEntry({
          id: `summary-${Date.now()}`,
          kind: "system",
          text: normalizedSummary,
        });
      }
    } catch (runError) {
      appendEntry({
        id: `error-${Date.now()}`,
        kind: "error",
        text: runError instanceof Error ? runError.message : "Remote terminal command failed.",
      });
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }, [appendEntry, bootstrap?.available, command, cwd, deviceId, prompt, running]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCommand();
      return;
    }

    if (event.key === "ArrowUp") {
      if (history.length === 0) {
        return;
      }
      event.preventDefault();
      setHistoryIndex((current) => {
        const nextIndex = current === null ? history.length - 1 : Math.max(0, current - 1);
        if (current === null) {
          setHistoryDraft(command);
        }
        setCommand(history[nextIndex] ?? "");
        return nextIndex;
      });
      return;
    }

    if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      setHistoryIndex((current) => {
        if (current === null) {
          return null;
        }
        const nextIndex = current + 1;
        if (nextIndex >= history.length) {
          setCommand(historyDraft);
          return null;
        }
        setCommand(history[nextIndex] ?? "");
        return nextIndex;
      });
    }
  }, [command, history, historyDraft, historyIndex, submitCommand]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-background/70">
            <SquareTerminal className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{deviceName}</p>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              {bootstrap?.transportLabel ?? "Auto-selecting shell transport"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {cwd?.trim().length ? (
            <div className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
              {cwd}
            </div>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void loadBootstrap(false)} disabled={loading || running}>
            {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEntries([])} disabled={entries.length === 0 || running}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </div>

      <div
        ref={outputRef}
        className="min-h-0 flex-1 overflow-auto bg-slate-950 px-4 py-4 font-mono text-[13px] text-slate-100"
      >
        {entries.length === 0 && !loading ? (
          <div className="text-sm text-slate-400">
            Preparing the interactive terminal surface for this device.
          </div>
        ) : null}

        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="whitespace-pre-wrap break-words">
              {entry.kind === "command" ? (
                <div className="flex gap-3">
                  <span className="select-none text-sky-300">{entry.prompt}</span>
                  <span className="text-slate-100">{entry.text}</span>
                </div>
              ) : (
                <pre
                  className={cn(
                    "whitespace-pre-wrap break-words leading-6",
                    entry.kind === "error"
                      ? "text-rose-300"
                      : entry.kind === "system"
                        ? "text-slate-400"
                        : "text-slate-100",
                  )}
                >
                  {entry.text}
                </pre>
              )}
            </div>
          ))}

          {running ? (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Running command…</span>
            </div>
          ) : null}
        </div>
      </div>

      <form
        className="border-t border-white/10 bg-slate-950/95 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCommand();
        }}
      >
        <div className="flex items-center gap-3">
          <span className="select-none whitespace-nowrap font-mono text-sm text-sky-300">
            {prompt}
          </span>
          <input
            ref={inputRef}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!bootstrap?.available || running}
            autoComplete="off"
            spellCheck={false}
            placeholder={bootstrap?.available ? "Enter a command" : "No terminal transport available"}
            className="h-8 w-full border-0 bg-transparent font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed"
          />
        </div>
      </form>
    </div>
  );
}
