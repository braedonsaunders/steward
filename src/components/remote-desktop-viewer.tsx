"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Keyboard, Maximize2, Minimize2, Monitor, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RemoteDesktopControlMode, RemoteDesktopProtocol } from "@/lib/remote-desktop/types";

interface RemoteDesktopViewerProps {
  sessionId: string;
  leaseId: string;
  deviceName: string;
  protocol: RemoteDesktopProtocol;
  controlMode: RemoteDesktopControlMode;
  bridgeWsUrl: string;
  bridgeConnectQuery: string;
  initialWidth: number;
  initialHeight: number;
}

interface GuacamoleTunnel {
  onerror?: ((event: unknown) => void) | null;
}

interface GuacamoleDisplay {
  scale: (scale: number) => void;
  getElement: () => HTMLElement;
  flatten?: () => { toDataURL: (type?: string) => string } | null;
  onresize?: ((width: number, height: number) => void) | null;
}

interface GuacamoleClientInstance {
  getDisplay: () => GuacamoleDisplay;
  sendMouseState: (state: unknown, applyDisplayScale?: boolean) => void;
  sendKeyEvent: (pressed: number, keysym: number) => void;
  connect: (query: string) => void;
  disconnect?: () => void;
  onstatechange?: ((nextState: number) => void) | null;
}

interface GuacamoleMouseInstance {
  onmousedown?: ((state: unknown) => void) | null;
  onmouseup?: ((state: unknown) => void) | null;
  onmousemove?: ((state: unknown) => void) | null;
}

interface GuacamoleKeyboardInstance {
  onkeydown?: ((keysym: number) => boolean) | null;
  onkeyup?: ((keysym: number) => boolean) | null;
}

interface GuacamoleNamespace {
  WebSocketTunnel: new (url: string) => GuacamoleTunnel;
  Client: {
    new (tunnel: GuacamoleTunnel): GuacamoleClientInstance;
    State: Record<string, number>;
  };
  Mouse: {
    new (element: HTMLElement): GuacamoleMouseInstance;
    State: new (template?: Record<string, unknown>) => unknown;
  };
  Keyboard: new (element: Document | HTMLElement) => GuacamoleKeyboardInstance;
}

interface RemoteStatusSnapshot {
  connected: boolean;
  status: string;
  width: number;
  height: number;
  scale: number;
  controlMode: RemoteDesktopControlMode;
}

type RemoteDesktopAutomationApi = {
  getStatus: () => RemoteStatusSnapshot;
  captureSnapshot: () => string | null;
  clickAt: (args: { x: number; y: number; clickCount?: number }) => Promise<void>;
  drag: (args: { fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }) => Promise<void>;
  scrollAt: (args: { x: number; y: number; direction: "up" | "down"; amount?: number }) => Promise<void>;
  typeText: (text: string) => Promise<void>;
  pressKey: (key: string) => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 20_000;

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Space: 0x20,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Shift: 0xffe1,
  Ctrl: 0xffe3,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffe7,
  Super: 0xffeb,
  Windows: 0xffeb,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeKeyName(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function keysymForCharacter(character: string): number | null {
  if (!character) {
    return null;
  }
  if (character === "\n" || character === "\r") {
    return SPECIAL_KEYSYMS.Enter;
  }
  if (character === "\t") {
    return SPECIAL_KEYSYMS.Tab;
  }
  const codepoint = character.codePointAt(0);
  if (!codepoint) {
    return null;
  }
  if (codepoint <= 0xff) {
    return codepoint;
  }
  if (codepoint <= 0x10ffff) {
    return 0x01000000 | codepoint;
  }
  return null;
}

async function loadGuacamole(): Promise<GuacamoleNamespace> {
  const mod = await import("guacamole-common-js");
  return (mod.default ?? mod) as GuacamoleNamespace;
}

export function RemoteDesktopViewer({
  sessionId,
  leaseId,
  deviceName,
  protocol,
  controlMode,
  bridgeWsUrl,
  bridgeConnectQuery,
  initialWidth,
  initialHeight,
}: RemoteDesktopViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const displayMountRef = useRef<HTMLDivElement | null>(null);
  const guacRef = useRef<GuacamoleNamespace | null>(null);
  const clientRef = useRef<GuacamoleClientInstance | null>(null);
  const keyboardRef = useRef<GuacamoleKeyboardInstance | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [scaleMode, setScaleMode] = useState<"fit" | "actual">("fit");
  const [scale, setScale] = useState(1);
  const [remoteSize, setRemoteSize] = useState({ width: initialWidth, height: initialHeight });
  const [connectNonce, setConnectNonce] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);

  const applyScale = useCallback(() => {
    const client = clientRef.current;
    const viewport = viewportRef.current;
    if (!client || !viewport || remoteSize.width <= 0 || remoteSize.height <= 0) {
      return;
    }

    const display = client.getDisplay();
    const nextScale = scaleMode === "actual"
      ? 1
      : Math.min(
        1,
        viewport.clientWidth / remoteSize.width,
        viewport.clientHeight / remoteSize.height,
      );
    const normalizedScale = Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1;
    display.scale(normalizedScale);
    setScale(normalizedScale);
  }, [remoteSize.height, remoteSize.width, scaleMode]);

  const focusViewport = useCallback(() => {
    viewportRef.current?.focus();
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root || typeof document === "undefined") {
      return;
    }
    if (document.fullscreenElement === root) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (typeof root.requestFullscreen === "function") {
      await root.requestFullscreen().catch(() => undefined);
    }
  }, []);

  const sendMouseState = useCallback((
    x: number,
    y: number,
    buttons?: Partial<Record<"left" | "middle" | "right" | "up" | "down", boolean>>,
  ) => {
    const client = clientRef.current;
    const Guacamole = guacRef.current;
    if (!client || !Guacamole?.Mouse?.State) {
      throw new Error("Remote desktop mouse state is unavailable.");
    }

    const state = new Guacamole.Mouse.State({
      x: Math.floor(x),
      y: Math.floor(y),
      left: Boolean(buttons?.left),
      middle: Boolean(buttons?.middle),
      right: Boolean(buttons?.right),
      up: Boolean(buttons?.up),
      down: Boolean(buttons?.down),
    });
    client.sendMouseState(state, false);
  }, []);

  const pressAndReleaseKeysym = useCallback(async (keysym: number) => {
    const client = clientRef.current;
    if (!client) {
      throw new Error("Remote desktop keyboard is unavailable.");
    }
    client.sendKeyEvent(1, keysym);
    await sleep(16);
    client.sendKeyEvent(0, keysym);
  }, []);

  const pressKey = useCallback(async (key: string) => {
    const normalized = normalizeKeyName(key);
    if (!normalized) {
      throw new Error("Key value is required.");
    }

    const combo = normalized.split("+").filter((part) => part.length > 0);
    if (combo.length > 1) {
      const client = clientRef.current;
      if (!client) {
        throw new Error("Remote desktop keyboard is unavailable.");
      }
      const keysyms = combo.map((part) => SPECIAL_KEYSYMS[part] ?? keysymForCharacter(part));
      const resolvedKeysyms = keysyms.filter((value): value is number => value !== null);
      if (resolvedKeysyms.length !== keysyms.length) {
        throw new Error(`Unsupported key combo: ${key}`);
      }
      for (const keysym of resolvedKeysyms) {
        client.sendKeyEvent(1, keysym);
      }
      await sleep(24);
      for (const keysym of [...resolvedKeysyms].reverse()) {
        client.sendKeyEvent(0, keysym);
      }
      return;
    }

    const keysym = SPECIAL_KEYSYMS[normalized] ?? keysymForCharacter(normalized);
    if (!keysym) {
      throw new Error(`Unsupported key: ${key}`);
    }
    await pressAndReleaseKeysym(keysym);
  }, [pressAndReleaseKeysym]);

  const typeText = useCallback(async (text: string) => {
    for (const character of Array.from(text ?? "")) {
      const keysym = keysymForCharacter(character);
      if (!keysym) {
        throw new Error(`Cannot type unsupported character: ${character}`);
      }
      await pressAndReleaseKeysym(keysym);
      await sleep(12);
    }
  }, [pressAndReleaseKeysym]);

  const captureSnapshot = useCallback(() => {
    const client = clientRef.current;
    const flattened = client?.getDisplay().flatten?.();
    if (!flattened || typeof flattened.toDataURL !== "function") {
      return null;
    }
    return flattened.toDataURL("image/png");
  }, []);

  const clickAt = useCallback(async ({ x, y, clickCount = 1 }: { x: number; y: number; clickCount?: number }) => {
    sendMouseState(x, y);
    await sleep(20);
    for (let index = 0; index < clickCount; index += 1) {
      sendMouseState(x, y, { left: true });
      await sleep(24);
      sendMouseState(x, y, { left: false });
      await sleep(48);
    }
  }, [sendMouseState]);

  const drag = useCallback(async ({
    fromX,
    fromY,
    toX,
    toY,
    durationMs = 320,
  }: {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    durationMs?: number;
  }) => {
    const steps = Math.max(6, Math.floor(durationMs / 24));
    sendMouseState(fromX, fromY);
    await sleep(20);
    sendMouseState(fromX, fromY, { left: true });
    await sleep(28);
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const nextX = fromX + (toX - fromX) * progress;
      const nextY = fromY + (toY - fromY) * progress;
      sendMouseState(nextX, nextY, { left: true });
      await sleep(Math.max(12, Math.floor(durationMs / steps)));
    }
    sendMouseState(toX, toY, { left: false });
  }, [sendMouseState]);

  const scrollAt = useCallback(async ({
    x,
    y,
    direction,
    amount = 3,
  }: {
    x: number;
    y: number;
    direction: "up" | "down";
    amount?: number;
  }) => {
    sendMouseState(x, y);
    await sleep(16);
    const normalizedAmount = clamp(amount, 1, 20);
    for (let index = 0; index < normalizedAmount; index += 1) {
      sendMouseState(x, y, direction === "up" ? { up: true } : { down: true });
      await sleep(12);
      sendMouseState(x, y, direction === "up" ? { up: false } : { down: false });
      await sleep(20);
    }
  }, [sendMouseState]);

  useEffect(() => {
    let cancelled = false;
    const displayMount = displayMountRef.current;

    const connect = async () => {
      let handshakeSettled = false;
      let handshakeTimeoutId: number | null = null;
      const settleHandshake = () => {
        handshakeSettled = true;
        if (handshakeTimeoutId !== null) {
          window.clearTimeout(handshakeTimeoutId);
          handshakeTimeoutId = null;
        }
      };

      setStatus("connecting");
      setError(null);

      const Guacamole = await loadGuacamole();
      if (cancelled) {
        return;
      }
      guacRef.current = Guacamole;

      const tunnel = new Guacamole.WebSocketTunnel(bridgeWsUrl);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      display.onresize = (width: number, height: number) => {
        if (cancelled) {
          return;
        }
        setRemoteSize({ width, height });
        window.requestAnimationFrame(() => applyScale());
      };

      if (displayMount) {
        displayMount.replaceChildren(display.getElement());
      }

      const mouse = new Guacamole.Mouse(display.getElement());
      const forwardMouse = (state: unknown) => {
        focusViewport();
        client.sendMouseState(state, true);
      };
      mouse.onmousedown = forwardMouse;
      mouse.onmouseup = forwardMouse;
      mouse.onmousemove = forwardMouse;

      const keyboardTarget = viewportRef.current;
      if (!keyboardTarget) {
        throw new Error("Remote desktop keyboard surface is unavailable.");
      }
      const keyboard = new Guacamole.Keyboard(keyboardTarget);
      keyboard.onkeydown = (keysym: number) => {
        client.sendKeyEvent(1, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym: number) => {
        client.sendKeyEvent(0, keysym);
        return false;
      };
      keyboardRef.current = keyboard;

      client.onstatechange = (nextState: number) => {
        if (cancelled) {
          return;
        }
        const stateEnum = Guacamole.Client.State;
        if (nextState === stateEnum.CONNECTED) {
          settleHandshake();
          setStatus("connected");
          setError(null);
          window.requestAnimationFrame(() => applyScale());
          return;
        }
        if (nextState === stateEnum.CONNECTING || nextState === stateEnum.WAITING) {
          setStatus("connecting");
          return;
        }
        if (nextState === stateEnum.DISCONNECTED) {
          settleHandshake();
          setStatus("disconnected");
        }
      };

      tunnel.onerror = (event: unknown) => {
        if (cancelled) {
          return;
        }
        settleHandshake();
        const message = typeof event === "string"
          ? event
          : event instanceof Error
            ? event.message
            : "Remote desktop bridge connection failed.";
        setError(message);
        setStatus("error");
      };

      try {
        handshakeTimeoutId = window.setTimeout(() => {
          if (cancelled || handshakeSettled) {
            return;
          }
          settleHandshake();
          setError("Remote desktop handshake timed out before the interactive session became available.");
          setStatus("error");
          try {
            client.disconnect?.();
          } catch {
            // Best-effort timeout cleanup only.
          }
        }, CONNECT_TIMEOUT_MS);
        client.connect(bridgeConnectQuery);
      } catch (connectionError) {
        if (!cancelled) {
          settleHandshake();
          setError(connectionError instanceof Error ? connectionError.message : "Remote desktop connection failed.");
          setStatus("error");
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      try {
        clientRef.current?.disconnect?.();
      } catch {
        // Best-effort teardown only.
      }
      setKeyboardCaptured(false);
      keyboardRef.current = null;
      clientRef.current = null;
      if (displayMount) {
        displayMount.replaceChildren();
      }
    };
  }, [applyScale, bridgeConnectQuery, bridgeWsUrl, connectNonce, focusViewport]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => applyScale());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [applyScale]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleFullscreenChange = () => {
      const fullscreen = document.fullscreenElement === rootRef.current;
      setIsFullscreen(fullscreen);
      window.requestAnimationFrame(() => applyScale());
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [applyScale]);

  useEffect(() => {
    // Assistant-driven remote desktop flows call into this browser API from Playwright.
    (window as Window & { __stewardRemoteDesktop?: RemoteDesktopAutomationApi }).__stewardRemoteDesktop = {
      getStatus: () => ({
        connected: status === "connected",
        status,
        width: remoteSize.width,
        height: remoteSize.height,
        scale,
        controlMode,
      }),
      captureSnapshot,
      clickAt,
      drag,
      scrollAt,
      typeText,
      pressKey,
    };

    return () => {
      delete (window as Window & { __stewardRemoteDesktop?: RemoteDesktopAutomationApi }).__stewardRemoteDesktop;
    };
  }, [captureSnapshot, clickAt, controlMode, drag, pressKey, remoteSize.height, remoteSize.width, scale, scrollAt, status, typeText]);

  const resolutionText = `${remoteSize.width} x ${remoteSize.height}`;
  const scaleText = `${Math.round(scale * 100)}%`;

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col rounded-2xl border border-border/70 bg-card/80 shadow-sm"
      data-steward-remote-session={sessionId}
      data-steward-remote-lease={leaseId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/70 bg-background/70">
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{deviceName}</p>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              Browser-native {protocol.toUpperCase()} session
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status === "connected" ? "default" : status === "error" ? "destructive" : "secondary"} data-steward-remote-status={status}>
            {status}
          </Badge>
          <Badge variant="outline">{controlMode === "observe" ? "Read only" : "Interactive"}</Badge>
          <Badge variant={keyboardCaptured ? "secondary" : "outline"}>
            {keyboardCaptured ? "Keyboard armed" : "Click to type"}
          </Badge>
          <Badge variant="outline">{resolutionText}</Badge>
          <Badge variant="outline">{scaleText}</Badge>
          <Button
            type="button"
            size="sm"
            variant={keyboardCaptured ? "secondary" : "outline"}
            onClick={focusViewport}
          >
            <Keyboard className="mr-1.5 h-3.5 w-3.5" />
            Keys
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scaleMode === "fit" ? "secondary" : "outline"}
            onClick={() => setScaleMode((current) => (current === "fit" ? "actual" : "fit"))}
          >
              {scaleMode === "fit" ? "Fit" : "100%"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void toggleFullscreen()}
          >
            {isFullscreen ? <Minimize2 className="mr-1.5 h-3.5 w-3.5" /> : <Maximize2 className="mr-1.5 h-3.5 w-3.5" />}
            {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setStatus("connecting");
              setError(null);
              setConnectNonce((current) => current + 1);
            }}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reconnect
          </Button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        tabIndex={0}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-slate-950/95 outline-none",
          keyboardCaptured && "ring-2 ring-sky-400/70 ring-inset",
        )}
        onFocus={() => setKeyboardCaptured(true)}
        onBlur={() => setKeyboardCaptured(false)}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.08),transparent_50%)]" />
        <div
          ref={displayMountRef}
          className={cn(
            "relative flex h-full w-full items-center justify-center p-3",
            status !== "connected" && "opacity-85",
          )}
          data-steward-remote-display="surface"
        />
        {status !== "connected" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-full border border-white/10 bg-slate-950/80 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-200 backdrop-blur">
              {status === "error" ? "Connection failed" : "Connecting"}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

