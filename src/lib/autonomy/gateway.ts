import { randomUUID } from "node:crypto";
import { approveAction, denyAction } from "@/lib/approvals/queue";
import { buildGlobalBriefing, buildOperatorStatusText } from "@/lib/autonomy/briefings";
import { autonomyStore } from "@/lib/autonomy/store";
import { appendGatewayConversationTurn, ensureThreadChatSession } from "@/lib/gateway/service";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

function nowIso(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readTransportMode(configJson: Record<string, unknown>): "polling" | "webhook" {
  return configJson.transportMode === "webhook" ? "webhook" : "polling";
}

function readPollingOffset(configJson: Record<string, unknown>): number {
  const value = Number(configJson.pollingUpdateOffset ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function extractThreadParts(threadKey: string): { chatId: string; messageThreadId?: number } {
  const [chatId, rawThreadId] = threadKey.split(":");
  const parsedThreadId = Number(rawThreadId ?? "");
  return {
    chatId,
    messageThreadId: Number.isFinite(parsedThreadId) && parsedThreadId > 0 ? parsedThreadId : undefined,
  };
}

function makeThreadKey(chatId: string | number, messageThreadId?: string | number): string {
  const normalizedChatId = String(chatId);
  const parsedThreadId = Number(messageThreadId ?? 0);
  return `${normalizedChatId}:${Number.isFinite(parsedThreadId) && parsedThreadId > 0 ? parsedThreadId : 0}`;
}

async function fetchText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function telegramTokenForBinding(bindingId: string): Promise<string> {
  const binding = autonomyStore.getGatewayBindingById(bindingId);
  if (!binding) {
    throw new Error("Gateway binding not found");
  }
  if (binding.kind !== "telegram") {
    throw new Error("Only Telegram bindings are supported");
  }
  if (!binding.vaultSecretRef) {
    throw new Error("Telegram binding is missing a bot token secret");
  }

  const token = await vault.getSecret(binding.vaultSecretRef);
  if (!token) {
    throw new Error("Telegram bot token is unavailable in the vault");
  }
  return token;
}

async function telegramRequestJson<T>(
  bindingId: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const token = await telegramTokenForBinding(bindingId);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await fetchText(response);
    throw new Error(`Telegram ${method} failed (${response.status}): ${body || response.statusText}`);
  }

  return await response.json() as T;
}

async function telegramRequest(bindingId: string, method: string, payload: Record<string, unknown>): Promise<void> {
  await telegramRequestJson(bindingId, method, payload);
}

function helpText(): string {
  return [
    "Steward Telegram gateway",
    "/status - overall Steward status",
    "/missions - active missions",
    "/subagents - subagent roster",
    "/investigations - open investigations",
    "/briefing - on-demand ops briefing",
    "/approve <playbookRunId> - approve a pending action",
    "/deny <playbookRunId> <reason> - deny a pending action",
    'You can also ask "what are you watching", "show open missions", or "why was <device> slow".',
  ].join("\n");
}

function missionListText(): string {
  const missions = autonomyStore.listMissions({ status: "active" });
  if (missions.length === 0) {
    return "No active missions.";
  }
  return [
    "Active missions",
    ...missions.slice(0, 12).map((mission) =>
      `- ${mission.title}: ${mission.lastStatus ?? "idle"}, next ${mission.nextRunAt ?? "unscheduled"}`,
    ),
  ].join("\n");
}

function subagentListText(): string {
  const subagents = autonomyStore.listSubagentsWithMetrics();
  if (subagents.length === 0) {
    return "No subagents are configured.";
  }
  return [
    "Subagents",
    ...subagents.map((subagent) =>
      `- ${subagent.name}: ${subagent.activeMissionCount} active mission(s), ${subagent.openInvestigationCount} open investigation(s), status ${subagent.status}`,
    ),
  ].join("\n");
}

function investigationListText(): string {
  const investigations = autonomyStore.listInvestigations({
    status: ["open", "monitoring"],
  });
  if (investigations.length === 0) {
    return "No open investigations.";
  }
  return [
    "Open investigations",
    ...investigations.slice(0, 12).map((investigation) =>
      `- ${investigation.title}: ${investigation.severity}, ${investigation.status}, stage ${investigation.stage}`,
    ),
  ].join("\n");
}

async function explainSlowQuery(subject: string): Promise<string> {
  const state = await stateStore.getState();
  const normalized = subject.toLowerCase();
  const relevantDeviceIds = state.devices
    .filter((device) => `${device.name} ${device.hostname ?? ""} ${device.ip}`.toLowerCase().includes(normalized))
    .map((device) => device.id);
  const incidentMatch = state.incidents
    .filter((incident) => incident.status !== "resolved")
    .find((incident) =>
      incident.summary.toLowerCase().includes(normalized)
      || incident.title.toLowerCase().includes(normalized)
      || incident.deviceIds.some((deviceId) => relevantDeviceIds.includes(deviceId)),
    );
  if (!incidentMatch) {
    return `I do not have a current latency or slowness incident for "${subject}". Try /briefing or check active investigations.`;
  }

  return [
    `Closest explanation for "${subject}"`,
    `- ${incidentMatch.title}`,
    `${incidentMatch.summary}`,
    `Severity: ${incidentMatch.severity}. Status: ${incidentMatch.status}.`,
  ].join("\n");
}

async function handleTelegramCommand(text: string): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return helpText();
  }

  if (!trimmed.startsWith("/")) {
    const normalized = trimmed.toLowerCase();
    if (normalized.includes("what are you watching")) {
      return [
        missionListText(),
        "",
        investigationListText(),
      ].join("\n");
    }
    if (normalized.includes("show open missions") || normalized.includes("open missions")) {
      return missionListText();
    }
    if (normalized.includes("show open investigations") || normalized.includes("open investigations")) {
      return investigationListText();
    }
    if (normalized.startsWith("why was ") && normalized.endsWith(" slow")) {
      const subject = trimmed.slice("why was ".length, Math.max("why was ".length, trimmed.length - " slow".length)).trim();
      if (subject) {
        return explainSlowQuery(subject);
      }
    }
    if (normalized.startsWith("why is ") && normalized.endsWith(" slow")) {
      const subject = trimmed.slice("why is ".length, Math.max("why is ".length, trimmed.length - " slow".length)).trim();
      if (subject) {
        return explainSlowQuery(subject);
      }
    }
    return helpText();
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  const args = rest.join(" ").trim();

  if (command === "/start" || command === "/help") {
    return helpText();
  }

  if (command === "/status") {
    return buildOperatorStatusText();
  }

  if (command === "/missions") {
    return missionListText();
  }

  if (command === "/subagents") {
    return subagentListText();
  }

  if (command === "/investigations") {
    return investigationListText();
  }

  if (command === "/briefing") {
    const briefing = await buildGlobalBriefing();
    return `${briefing.title}\n\n${briefing.body}`;
  }

  if (command === "/approve") {
    if (!args) {
      return "Usage: /approve <playbookRunId>";
    }
    const approved = approveAction(args, "telegram");
    return approved
      ? `Approved ${approved.name}.`
      : `Could not approve ${args}. It may already be processed or expired.`;
  }

  if (command === "/deny") {
    const [id, ...reasonParts] = args.split(/\s+/);
    if (!id) {
      return "Usage: /deny <playbookRunId> <reason>";
    }
    const denied = denyAction(id, "telegram", reasonParts.join(" ").trim());
    return denied
      ? `Denied ${denied.name}.`
      : `Could not deny ${id}. It may already be processed or expired.`;
  }

  return helpText();
}

export async function sendGatewayMessage(
  bindingId: string,
  text: string,
  options?: {
    threadKey?: string;
  },
): Promise<void> {
  const binding = autonomyStore.getGatewayBindingById(bindingId);
  if (!binding) {
    throw new Error("Gateway binding not found");
  }
  if (binding.kind !== "telegram") {
    throw new Error(`Unsupported gateway binding kind: ${binding.kind}`);
  }

  const threadKey = options?.threadKey ?? binding.target;
  if (!threadKey) {
    throw new Error("Gateway binding does not have a target thread yet");
  }

  const { chatId, messageThreadId } = extractThreadParts(threadKey);
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_notification: false,
  };
  if (messageThreadId) {
    payload.message_thread_id = messageThreadId;
  }

  await telegramRequest(binding.id, "sendMessage", payload);
  autonomyStore.touchGatewayBindingActivity(binding.id, "outbound");

  const existingThread = autonomyStore.getGatewayThreadByExternalKey(binding.id, threadKey);
  if (existingThread) {
    autonomyStore.touchGatewayThreadActivity(existingThread.id, "outbound");
  }

  await stateStore.addAction({
    actor: "steward",
    kind: "gateway",
    message: `Delivered Telegram gateway message via ${binding.name}`,
    context: {
      bindingId: binding.id,
      threadKey,
    },
  });
}

export async function syncTelegramWebhook(bindingId: string): Promise<void> {
  const binding = autonomyStore.getGatewayBindingById(bindingId);
  if (!binding) {
    throw new Error("Gateway binding not found");
  }
  if (binding.kind !== "telegram") {
    throw new Error("Only Telegram bindings support webhook sync");
  }

  const config = asRecord(binding.configJson);
  const transportMode = readTransportMode(config);
  const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
  if (!binding.enabled) {
    await telegramRequest(binding.id, "deleteWebhook", {
      drop_pending_updates: false,
    });
    return;
  }

  if (transportMode === "polling" || webhookUrl.length === 0) {
    await telegramRequest(binding.id, "deleteWebhook", {
      drop_pending_updates: false,
    });
    return;
  }

  await telegramRequest(binding.id, "setWebhook", {
    url: webhookUrl,
    secret_token: binding.webhookSecret ?? undefined,
    allowed_updates: ["message"],
  });
}

async function processTelegramUpdate(
  binding: NonNullable<ReturnType<typeof autonomyStore.getGatewayBindingById>>,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; ignored?: boolean }> {
  const message = asRecord(payload.message);
  const chat = asRecord(message.chat);
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const chatId = chat.id;
  const updateId = payload.update_id;
  const normalizedUpdateId = typeof updateId === "string" || typeof updateId === "number"
    ? String(updateId)
    : undefined;

  if ((typeof chatId !== "string" && typeof chatId !== "number") || text.length === 0) {
    return { ok: true, ignored: true };
  }

  const rawMessageThreadId = message.message_thread_id;
  const messageThreadId = typeof rawMessageThreadId === "string" || typeof rawMessageThreadId === "number"
    ? rawMessageThreadId
    : undefined;
  const threadKey = makeThreadKey(chatId, messageThreadId);
  const threadTitle = typeof chat.title === "string" && chat.title.trim().length > 0
    ? chat.title
    : typeof chat.username === "string" && chat.username.trim().length > 0
      ? `@${chat.username}`
      : binding.defaultThreadTitle ?? `Telegram ${chatId}`;

  const thread = autonomyStore.getOrCreateGatewayThread({
    bindingId: binding.id,
    externalThreadKey: threadKey,
    title: threadTitle,
    lastInboundAt: nowIso(),
  });
  if (normalizedUpdateId && autonomyStore.getGatewayInboundEvent(binding.id, normalizedUpdateId)) {
    return { ok: true, ignored: true };
  }
  if (normalizedUpdateId) {
    autonomyStore.recordGatewayInboundEvent({
      bindingId: binding.id,
      externalUpdateId: normalizedUpdateId,
      threadId: thread.id,
      receivedAt: nowIso(),
    });
  }
  autonomyStore.touchGatewayBindingActivity(binding.id, "inbound");
  autonomyStore.touchGatewayThreadActivity(thread.id, "inbound");
  ensureThreadChatSession(thread.id);

  if (!binding.target) {
    autonomyStore.upsertGatewayBinding({
      ...binding,
      target: threadKey,
      updatedAt: nowIso(),
      lastInboundAt: nowIso(),
    });
  }

  appendGatewayConversationTurn({
    threadId: thread.id,
    role: "user",
    content: text,
    provider: "telegram",
  });
  const responseText = await handleTelegramCommand(text);
  if (responseText.trim().length > 0) {
    await sendGatewayMessage(binding.id, responseText, { threadKey });
    appendGatewayConversationTurn({
      threadId: thread.id,
      role: "assistant",
      content: responseText,
      provider: "telegram",
    });
  }

  await stateStore.addAction({
    actor: "steward",
    kind: "gateway",
    message: `Processed Telegram gateway command ${text.split(/\s+/)[0]}`,
    context: {
      bindingId: binding.id,
      threadId: thread.id,
      threadKey,
      updateId: normalizedUpdateId ?? randomUUID(),
    },
  });

  return { ok: true };
}

const gatewayPollingInFlight = new Set<string>();

export async function pollTelegramBinding(bindingId: string): Promise<number> {
  if (gatewayPollingInFlight.has(bindingId)) {
    return 0;
  }

  const binding = autonomyStore.getGatewayBindingById(bindingId);
  if (!binding || binding.kind !== "telegram" || !binding.enabled) {
    return 0;
  }

  const config = asRecord(binding.configJson);
  if (readTransportMode(config) !== "polling") {
    return 0;
  }

  gatewayPollingInFlight.add(bindingId);
  try {
    const offset = readPollingOffset(config);
    const response = await telegramRequestJson<{
      ok?: boolean;
      result?: Array<Record<string, unknown>>;
      description?: string;
    }>(binding.id, "getUpdates", {
      offset,
      limit: 20,
      timeout: 0,
      allowed_updates: ["message"],
    });

    if (!response.ok) {
      throw new Error(response.description ?? "Telegram getUpdates failed");
    }

    const updates = Array.isArray(response.result) ? response.result : [];
    let nextOffset = offset;
    for (const update of updates) {
      const updateRecord = asRecord(update);
      const updateId = Number(updateRecord.update_id ?? 0);
      if (Number.isFinite(updateId) && updateId >= nextOffset) {
        nextOffset = updateId + 1;
      }
      await processTelegramUpdate(binding, updateRecord);
    }

    autonomyStore.upsertGatewayBinding({
      ...binding,
      configJson: {
        ...config,
        transportMode: "polling",
        pollingUpdateOffset: nextOffset,
        pollingLastSyncAt: nowIso(),
      },
      updatedAt: binding.updatedAt,
    });
    return updates.length;
  } finally {
    gatewayPollingInFlight.delete(bindingId);
  }
}

export async function handleTelegramWebhook(
  bindingId: string,
  request: Request,
): Promise<{ ok: boolean; ignored?: boolean }> {
  const binding = autonomyStore.getGatewayBindingById(bindingId);
  if (!binding || binding.kind !== "telegram") {
    throw new Error("Telegram binding not found");
  }

  const presentedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (binding.webhookSecret && presentedSecret !== binding.webhookSecret) {
    throw new Error("Invalid Telegram webhook secret");
  }

  return processTelegramUpdate(binding, asRecord(await request.json()));
}
