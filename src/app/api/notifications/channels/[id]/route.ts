import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { redactNotificationChannel } from "@/lib/notifications/manager";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const eventKindSchema = z.enum([
  "incident.opened",
  "approval.requested",
  "approval.escalated",
  "approval.expired",
]);

const updateChannelSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  target: z.string().trim().min(1).max(2048).optional(),
  eventKinds: z.array(eventKindSchema).min(1).max(12).optional(),
  minimumSeverity: z.enum(["critical", "warning", "info"]).nullable().optional(),
  configJson: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(8192).optional(),
  clearSecret: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = stateStore.getNotificationChannelById(id);
  if (!existing) {
    return NextResponse.json({ error: "Notification channel not found" }, { status: 404 });
  }

  const payload = updateChannelSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const nextSecretRef = payload.data.clearSecret
    ? undefined
    : existing.vaultSecretRef ?? (payload.data.secret ? `notification.channel.${existing.id}.secret` : undefined);
  if (payload.data.clearSecret && existing.vaultSecretRef) {
    await vault.deleteSecret(existing.vaultSecretRef).catch(() => {});
  }
  if (payload.data.secret && nextSecretRef) {
    await vault.setSecret(nextSecretRef, payload.data.secret);
  }

  const updated = stateStore.upsertNotificationChannel({
    ...existing,
    name: payload.data.name ?? existing.name,
    enabled: payload.data.enabled ?? existing.enabled,
    target: payload.data.target ?? existing.target,
    eventKinds: payload.data.eventKinds ? Array.from(new Set(payload.data.eventKinds)) : existing.eventKinds,
    minimumSeverity: payload.data.minimumSeverity === null
      ? undefined
      : payload.data.minimumSeverity ?? existing.minimumSeverity,
    vaultSecretRef: nextSecretRef,
    configJson: payload.data.configJson ?? existing.configJson,
    updatedAt: new Date().toISOString(),
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated notification channel "${updated.name}"`,
    context: {
      channelId: updated.id,
      kind: updated.kind,
      eventKinds: updated.eventKinds,
      enabled: updated.enabled,
    },
  });

  return NextResponse.json({ channel: redactNotificationChannel(updated) });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = stateStore.getNotificationChannelById(id);
  if (!existing) {
    return NextResponse.json({ error: "Notification channel not found" }, { status: 404 });
  }

  if (existing.vaultSecretRef) {
    await vault.deleteSecret(existing.vaultSecretRef).catch(() => {});
  }
  stateStore.deleteNotificationChannel(id);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Deleted notification channel "${existing.name}"`,
    context: {
      channelId: existing.id,
      kind: existing.kind,
    },
  });

  return NextResponse.json({ ok: true });
}
