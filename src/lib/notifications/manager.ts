import { randomUUID } from "node:crypto";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type {
  IncidentSeverity,
  NotificationChannel,
  NotificationDelivery,
  NotificationEventKind,
} from "@/lib/state/types";

const NOTIFICATION_JOB_KIND = "notification.deliver";

export interface NotificationEventInput {
  kind: NotificationEventKind;
  eventRef: string;
  dedupeKey: string;
  title: string;
  body: string;
  severity?: IncidentSeverity;
  metadata?: Record<string, unknown>;
}

export interface NotificationWorkerSummary {
  claimed: number;
  delivered: number;
  failed: number;
}

export interface RedactedNotificationChannel extends Omit<NotificationChannel, "vaultSecretRef"> {
  hasSecret: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function severityRank(value?: IncidentSeverity): number {
  if (value === "critical") return 3;
  if (value === "warning") return 2;
  if (value === "info") return 1;
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function channelMatchesEvent(channel: NotificationChannel, event: NotificationEventInput): boolean {
  if (!channel.enabled) {
    return false;
  }
  if (!(channel.eventKinds ?? []).includes(event.kind)) {
    return false;
  }
  if (event.severity && channel.minimumSeverity) {
    return severityRank(event.severity) >= severityRank(channel.minimumSeverity);
  }
  return true;
}

function notificationText(event: NotificationEventInput): string {
  const severityLine = event.severity ? `Severity: ${event.severity}\n` : "";
  return `${event.title}\n${severityLine}${event.body}`.trim();
}

async function fetchText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function deliverTelegram(channel: NotificationChannel, event: NotificationEventInput): Promise<void> {
  const tokenRef = channel.vaultSecretRef;
  if (!tokenRef) {
    throw new Error("Telegram channel is missing a bot token secret");
  }
  const token = await vault.getSecret(tokenRef);
  if (!token) {
    throw new Error("Telegram bot token is unavailable in the vault");
  }

  const config = asRecord(channel.configJson);
  const payload: Record<string, unknown> = {
    chat_id: channel.target,
    text: notificationText(event),
    disable_notification: Boolean(config.disableNotification),
  };
  const messageThreadId = config.messageThreadId;
  if (typeof messageThreadId === "number" || typeof messageThreadId === "string") {
    payload.message_thread_id = messageThreadId;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await fetchText(response);
    throw new Error(`Telegram delivery failed (${response.status}): ${body || response.statusText}`);
  }
}

async function deliverWebhook(channel: NotificationChannel, event: NotificationEventInput): Promise<void> {
  const config = asRecord(channel.configJson);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)) {
    for (const [key, value] of Object.entries(config.headers as Record<string, unknown>)) {
      if (typeof value === "string" && key.trim().length > 0) {
        headers[key] = value;
      }
    }
  }

  if (channel.vaultSecretRef) {
    const secret = await vault.getSecret(channel.vaultSecretRef);
    if (!secret) {
      throw new Error("Webhook secret is unavailable in the vault");
    }
    const headerName = typeof config.secretHeaderName === "string" && config.secretHeaderName.trim().length > 0
      ? config.secretHeaderName.trim()
      : "Authorization";
    const headerPrefix = typeof config.secretHeaderPrefix === "string"
      ? config.secretHeaderPrefix
      : "Bearer ";
    headers[headerName] = `${headerPrefix}${secret}`;
  }

  const response = await fetch(channel.target, {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventKind: event.kind,
      eventRef: event.eventRef,
      title: event.title,
      body: event.body,
      severity: event.severity ?? null,
      metadata: event.metadata ?? {},
      sentAt: nowIso(),
    }),
  });

  if (!response.ok) {
    const body = await fetchText(response);
    throw new Error(`Webhook delivery failed (${response.status}): ${body || response.statusText}`);
  }
}

async function deliverNotification(channel: NotificationChannel, event: NotificationEventInput): Promise<void> {
  if (channel.kind === "telegram") {
    await deliverTelegram(channel, event);
    return;
  }
  if (channel.kind === "webhook") {
    await deliverWebhook(channel, event);
    return;
  }
  throw new Error(`Unsupported notification channel kind: ${channel.kind}`);
}

export function redactNotificationChannel(channel: NotificationChannel): RedactedNotificationChannel {
  return {
    id: channel.id,
    name: channel.name,
    kind: channel.kind,
    enabled: channel.enabled,
    target: channel.target,
    eventKinds: channel.eventKinds,
    minimumSeverity: channel.minimumSeverity,
    configJson: channel.configJson,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    hasSecret: Boolean(channel.vaultSecretRef),
  };
}

export async function enqueueNotificationEvent(event: NotificationEventInput): Promise<number> {
  const channels = stateStore.getNotificationChannels().filter((channel) => channelMatchesEvent(channel, event));
  let enqueued = 0;

  for (const channel of channels) {
    const delivery: NotificationDelivery = {
      id: randomUUID(),
      channelId: channel.id,
      eventKind: event.kind,
      eventRef: event.eventRef,
      summary: event.title,
      payloadJson: {
        title: event.title,
        body: event.body,
        severity: event.severity ?? null,
        metadata: event.metadata ?? {},
      },
      status: "pending",
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    stateStore.upsertNotificationDelivery(delivery);
    stateStore.enqueueDurableJob(
      NOTIFICATION_JOB_KIND,
      {
        deliveryId: delivery.id,
        channelId: channel.id,
        event,
      },
      `${NOTIFICATION_JOB_KIND}:${channel.id}:${event.dedupeKey}`,
    );
    enqueued += 1;
  }

  return enqueued;
}

export async function processNotificationJobs(limit = 25): Promise<NotificationWorkerSummary> {
  const jobs = stateStore.claimDurableJobs(limit, { kinds: [NOTIFICATION_JOB_KIND] });
  let delivered = 0;
  let failed = 0;

  for (const job of jobs) {
    const deliveryId = typeof job.payload.deliveryId === "string" ? job.payload.deliveryId : "";
    const channelId = typeof job.payload.channelId === "string" ? job.payload.channelId : "";
    const event = asRecord(job.payload.event) as unknown as NotificationEventInput;

    const delivery = deliveryId ? stateStore.getNotificationDeliveryById(deliveryId) : null;
    const channel = channelId ? stateStore.getNotificationChannelById(channelId) : null;
    if (!delivery || !channel) {
      if (delivery) {
        stateStore.upsertNotificationDelivery({
          ...delivery,
          status: "failed",
          attempts: delivery.attempts + 1,
          lastError: "Notification delivery target no longer exists",
          updatedAt: nowIso(),
        });
      }
      stateStore.completeDurableJob(job.id);
      failed += 1;
      continue;
    }

    try {
      await deliverNotification(channel, event);
      stateStore.upsertNotificationDelivery({
        ...delivery,
        status: "delivered",
        attempts: delivery.attempts + 1,
        lastError: undefined,
        deliveredAt: nowIso(),
        updatedAt: nowIso(),
      });
      stateStore.completeDurableJob(job.id);
      delivered += 1;

      void stateStore.addAction({
        actor: "steward",
        kind: "notification",
        message: `Delivered ${event.kind} notification via ${channel.kind}`,
        context: {
          channelId: channel.id,
          deliveryId: delivery.id,
          eventKind: event.kind,
          eventRef: event.eventRef,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stateStore.upsertNotificationDelivery({
        ...delivery,
        status: "failed",
        attempts: delivery.attempts + 1,
        lastError: message,
        updatedAt: nowIso(),
      });
      stateStore.failDurableJob(job.id, message, Math.min(15 * 60_000, 30_000 * Math.max(1, job.attempts + 1)));
      failed += 1;
    }
  }

  return {
    claimed: jobs.length,
    delivered,
    failed,
  };
}
