import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { redactNotificationChannel } from "@/lib/notifications/manager";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";
import type { NotificationChannel } from "@/lib/state/types";

export const runtime = "nodejs";

const eventKindSchema = z.enum([
  "incident.opened",
  "approval.requested",
  "approval.escalated",
  "approval.expired",
]);

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["telegram", "webhook"]),
  enabled: z.boolean().optional(),
  target: z.string().trim().min(1).max(2048),
  eventKinds: z.array(eventKindSchema).min(1).max(12),
  minimumSeverity: z.enum(["critical", "warning", "info"]).nullish(),
  configJson: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(8192).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    channels: stateStore.getNotificationChannels().map(redactNotificationChannel),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = createChannelSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const vaultSecretRef = payload.data.secret ? `notification.channel.${id}.secret` : undefined;
  if (payload.data.secret && vaultSecretRef) {
    await vault.setSecret(vaultSecretRef, payload.data.secret);
  }

  const channel: NotificationChannel = {
    id,
    name: payload.data.name,
    kind: payload.data.kind,
    enabled: payload.data.enabled ?? true,
    target: payload.data.target,
    eventKinds: Array.from(new Set(payload.data.eventKinds)),
    minimumSeverity: payload.data.minimumSeverity ?? undefined,
    vaultSecretRef,
    configJson: payload.data.configJson ?? {},
    createdAt: now,
    updatedAt: now,
  };

  stateStore.upsertNotificationChannel(channel);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Created notification channel "${channel.name}"`,
    context: {
      channelId: channel.id,
      kind: channel.kind,
      eventKinds: channel.eventKinds,
      enabled: channel.enabled,
    },
  });

  return NextResponse.json({ channel: redactNotificationChannel(channel) }, { status: 201 });
}
