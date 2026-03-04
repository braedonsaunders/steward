"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { LLMProvider, StewardState } from "@/lib/state/types";

type ApiState = StewardState & {
  actions: StewardState["actions"];
};

interface ToastState {
  tone: "ok" | "error";
  message: string;
}

const providerOptions: LLMProvider[] = ["openai", "anthropic", "google", "openrouter"];

const fetchJson = async <T,>(input: RequestInfo, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as T;
};

export function StewardDashboard() {
  const [state, setState] = useState<ApiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [chatProvider, setChatProvider] = useState<LLMProvider>("openai");
  const [chatInput, setChatInput] = useState("");
  const [chatOutput, setChatOutput] = useState<string[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  const [newDeviceName, setNewDeviceName] = useState("");
  const [newDeviceIp, setNewDeviceIp] = useState("");

  const [vaultPassphrase, setVaultPassphrase] = useState("");
  const [vaultStatus, setVaultStatus] = useState<{
    initialized: boolean;
    unlocked: boolean;
    keyCount: number;
  } | null>(null);

  const [providerDraft, setProviderDraft] = useState<
    Record<string, { model: string; apiKey: string; enabled: boolean }>
  >({});

  const loadState = async () => {
    const [stateResponse, vaultResponse] = await Promise.all([
      fetchJson<ApiState>("/api/state"),
      fetchJson<{ initialized: boolean; unlocked: boolean; keyCount: number }>("/api/vault"),
    ]);

    setState(stateResponse);
    setVaultStatus(vaultResponse);

    const drafts: Record<string, { model: string; apiKey: string; enabled: boolean }> = {};
    for (const config of stateResponse.providerConfigs) {
      drafts[config.provider] = {
        model: config.model,
        apiKey: "",
        enabled: config.enabled,
      };
    }

    setProviderDraft(drafts);
  };

  useEffect(() => {
    let active = true;

    const run = async () => {
      try {
        await loadState();
      } catch (error) {
        if (!active) {
          return;
        }

        setToast({
          tone: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, 20_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    const provider = params.get("provider");
    const reason = params.get("reason");

    if (oauth === "success") {
      setToast({
        tone: "ok",
        message: `OAuth connected for ${provider ?? "provider"}.`,
      });
      window.history.replaceState({}, "", "/");
      return;
    }

    if (oauth === "error") {
      setToast({
        tone: "error",
        message: `OAuth failed for ${provider ?? "provider"}${reason ? `: ${reason}` : ""}`,
      });
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const overview = useMemo(() => {
    if (!state) {
      return {
        devices: 0,
        online: 0,
        incidents: 0,
        recommendations: 0,
      };
    }

    return {
      devices: state.devices.length,
      online: state.devices.filter((device) => device.status === "online").length,
      incidents: state.incidents.filter((incident) => incident.status !== "resolved").length,
      recommendations: state.recommendations.filter((item) => !item.dismissed).length,
    };
  }, [state]);

  const onRunCycle = async () => {
    try {
      const result = await fetchJson<{ ok: boolean; summary: Record<string, number> }>(
        "/api/agent/run",
        {
          method: "POST",
        },
      );

      setToast({
        tone: "ok",
        message: `Cycle complete. discovered=${result.summary.discovered}, incidents=${result.summary.incidentsOpened}`,
      });

      await loadState();
    } catch (error) {
      setToast({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onAddDevice = async (event: FormEvent) => {
    event.preventDefault();

    if (!newDeviceName || !newDeviceIp) {
      return;
    }

    try {
      await fetchJson("/api/devices", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: newDeviceName,
          ip: newDeviceIp,
        }),
      });

      setNewDeviceName("");
      setNewDeviceIp("");
      setToast({ tone: "ok", message: "Device added." });
      await loadState();
    } catch (error) {
      setToast({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onVaultAction = async (action: "init" | "unlock" | "lock") => {
    try {
      await fetchJson("/api/vault", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action,
          passphrase: action === "lock" ? undefined : vaultPassphrase,
        }),
      });

      if (action !== "lock") {
        setVaultPassphrase("");
      }

      setToast({ tone: "ok", message: `Vault ${action} successful.` });
      await loadState();
    } catch (error) {
      setToast({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onSaveProvider = async (provider: LLMProvider) => {
    const draft = providerDraft[provider];
    if (!draft) {
      return;
    }

    try {
      await fetchJson("/api/providers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          enabled: draft.enabled,
          model: draft.model,
          apiKey: draft.apiKey || undefined,
        }),
      });

      setProviderDraft((current) => ({
        ...current,
        [provider]: {
          ...current[provider],
          apiKey: "",
        },
      }));

      setToast({ tone: "ok", message: `${provider} configuration saved.` });
      await loadState();
    } catch (error) {
      setToast({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onChat = async (event: FormEvent) => {
    event.preventDefault();

    if (!chatInput || chatBusy) {
      return;
    }

    const input = chatInput;
    setChatInput("");
    setChatBusy(true);
    setChatOutput((current) => [`You: ${input}`, ...current]);

    try {
      const result = await fetchJson<{ provider: string; response: string }>("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input,
          provider: chatProvider,
        }),
      });

      setChatOutput((current) => [`Steward (${result.provider}): ${result.response}`, ...current]);
    } catch (error) {
      setChatOutput((current) => [
        `Steward: failed to answer (${error instanceof Error ? error.message : String(error)})`,
        ...current,
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  if (loading) {
    return <main className="shell">Bootstrapping Steward...</main>;
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Steward</p>
        <h1>Your network&apos;s first employee.</h1>
        <p>
          Autonomous infrastructure operations for small teams. Discover, understand, act, and
          learn continuously.
        </p>
        <div className="heroActions">
          <button onClick={onRunCycle} className="primaryButton">
            Run Agent Cycle Now
          </button>
          <span>
            Vault: {vaultStatus?.initialized ? "initialized" : "not initialized"} /{" "}
            {vaultStatus?.unlocked ? "unlocked" : "locked"}
          </span>
        </div>
      </section>

      {toast ? (
        <section className={`toast ${toast.tone}`}>
          <strong>{toast.tone === "ok" ? "OK" : "Error"}:</strong> {toast.message}
        </section>
      ) : null}

      <section className="statsGrid">
        <article>
          <h2>{overview.devices}</h2>
          <p>Known Devices</p>
        </article>
        <article>
          <h2>{overview.online}</h2>
          <p>Online</p>
        </article>
        <article>
          <h2>{overview.incidents}</h2>
          <p>Open Incidents</p>
        </article>
        <article>
          <h2>{overview.recommendations}</h2>
          <p>Active Recommendations</p>
        </article>
      </section>

      <section className="grid">
        <article className="panel">
          <header>
            <h3>Device Inventory</h3>
          </header>

          <form onSubmit={onAddDevice} className="inlineForm">
            <input
              value={newDeviceName}
              onChange={(event) => setNewDeviceName(event.target.value)}
              placeholder="Device name"
            />
            <input
              value={newDeviceIp}
              onChange={(event) => setNewDeviceIp(event.target.value)}
              placeholder="IP address"
            />
            <button type="submit">Add</button>
          </form>

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>IP</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Protocols</th>
                  <th>Tier</th>
                </tr>
              </thead>
              <tbody>
                {state?.devices.slice(0, 80).map((device) => (
                  <tr key={device.id}>
                    <td>{device.name}</td>
                    <td>{device.ip}</td>
                    <td>{device.type}</td>
                    <td>{device.status}</td>
                    <td>{device.protocols.join(", ") || "-"}</td>
                    <td>{device.autonomyTier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <header>
            <h3>Incident Feed</h3>
          </header>

          <ul className="stackList">
            {state?.incidents.slice(0, 20).map((incident) => (
              <li key={incident.id}>
                <p>
                  <strong>[{incident.severity.toUpperCase()}]</strong> {incident.title}
                </p>
                <p>{incident.summary}</p>
                <small>
                  status={incident.status} | devices={incident.deviceIds.length} | updated=
                  {new Date(incident.updatedAt).toLocaleString()}
                </small>
              </li>
            ))}
            {state?.incidents.length === 0 ? <li>No incidents yet.</li> : null}
          </ul>
        </article>

        <article className="panel">
          <header>
            <h3>Recommendations</h3>
          </header>

          <ul className="stackList">
            {state?.recommendations
              .filter((recommendation) => !recommendation.dismissed)
              .slice(0, 20)
              .map((recommendation) => (
                <li key={recommendation.id}>
                  <p>
                    <strong>[{recommendation.priority.toUpperCase()}]</strong> {recommendation.title}
                  </p>
                  <p>{recommendation.rationale}</p>
                  <small>{recommendation.impact}</small>
                </li>
              ))}
            {state?.recommendations.filter((recommendation) => !recommendation.dismissed).length ===
            0 ? (
              <li>No active recommendations.</li>
            ) : null}
          </ul>
        </article>

        <article className="panel">
          <header>
            <h3>Conversation</h3>
          </header>

          <form onSubmit={onChat} className="chatForm">
            <select
              value={chatProvider}
              onChange={(event) => setChatProvider(event.target.value as LLMProvider)}
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
            <input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask Steward anything about your environment"
            />
            <button type="submit" disabled={chatBusy}>
              {chatBusy ? "Thinking..." : "Send"}
            </button>
          </form>

          <ul className="chatLog">
            {chatOutput.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <header>
            <h3>LLM Providers</h3>
          </header>

          <div className="providerStack">
            {state?.providerConfigs.map((config) => {
              const draft = providerDraft[config.provider] ?? {
                model: config.model,
                apiKey: "",
                enabled: config.enabled,
              };

              return (
                <div className="providerCard" key={config.provider}>
                  <h4>{config.provider}</h4>
                  <label>
                    <span>Model</span>
                    <input
                      value={draft.model}
                      onChange={(event) =>
                        setProviderDraft((current) => ({
                          ...current,
                          [config.provider]: {
                            ...draft,
                            model: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>API Key (optional update)</span>
                    <input
                      value={draft.apiKey}
                      onChange={(event) =>
                        setProviderDraft((current) => ({
                          ...current,
                          [config.provider]: {
                            ...draft,
                            apiKey: event.target.value,
                          },
                        }))
                      }
                      placeholder="sk-..."
                    />
                  </label>
                  <label className="checkboxRow">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setProviderDraft((current) => ({
                          ...current,
                          [config.provider]: {
                            ...draft,
                            enabled: event.target.checked,
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>
                  <div className="providerActions">
                    <button onClick={() => onSaveProvider(config.provider)}>
                      Save {config.provider}
                    </button>
                    <a href={`/api/providers/oauth/start?provider=${config.provider}`}>
                      Connect OAuth
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="panel">
          <header>
            <h3>Vault</h3>
          </header>

          <div className="vaultActions">
            <input
              type="password"
              value={vaultPassphrase}
              onChange={(event) => setVaultPassphrase(event.target.value)}
              placeholder="Vault passphrase"
            />
            <div>
              <button onClick={() => onVaultAction("init")}>Initialize</button>
              <button onClick={() => onVaultAction("unlock")}>Unlock</button>
              <button onClick={() => onVaultAction("lock")}>Lock</button>
            </div>
            <small>Stored keys: {vaultStatus?.keyCount ?? 0}</small>
          </div>
        </article>
      </section>
    </main>
  );
}
