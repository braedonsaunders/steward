export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { syncTelegramWebhook } from "@/lib/autonomy/gateway";
import { autonomyStore } from "@/lib/autonomy/store";
import type { GatewayBindingRecord } from "@/lib/autonomy/types";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

const BindingPatchSchema = z.object({
  name: z.string().min(2).optional(),
  enabled: z.boolean().optional(),
  target: z.string().optional(),
  botToken: z.string().optional(),
  webhookSecret: z.string().nullable().optional(),
  defaultThreadTitle: z.string().nullable().optional(),
  transportMode: z.enum(["polling", "webhook"]).optional(),
  webhookUrl: z.string().url().nullable().optional(),
});

function redactBinding(binding: GatewayBindingRecord) {
  const configJson = {
    ...binding.configJson,
    transportMode: binding.configJson.transportMode === "webhook"
      ? "webhook"
      : binding.configJson.webhookUrl
        ? "webhook"
        : "polling",
  };
  return {
    id: binding.id,
    kind: binding.kind,
    name: binding.name,
    enabled: binding.enabled,
    target: binding.target,
    webhookSecretConfigured: Boolean(binding.webhookSecret),
    defaultThreadTitle: binding.defaultThreadTitle,
    configJson,
    lastInboundAt: binding.lastInboundAt,
    lastOutboundAt: binding.lastOutboundAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    hasSecret: Boolean(binding.vaultSecretRef),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const binding = autonomyStore.getGatewayBindingById(id);
  if (!binding) {
    return NextResponse.json({ error: "Binding not found" }, { status: 404 });
  }

  return NextResponse.json(redactBinding(binding));
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const binding = autonomyStore.getGatewayBindingById(id);
  if (!binding) {
    return NextResponse.json({ error: "Binding not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = BindingPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const currentTransportMode = binding.configJson.transportMode === "webhook"
    ? "webhook"
    : binding.configJson.webhookUrl
      ? "webhook"
      : "polling";
  const webhookUrl = parsed.data.webhookUrl === undefined
    ? (typeof binding.configJson.webhookUrl === "string" ? binding.configJson.webhookUrl : undefined)
    : parsed.data.webhookUrl ?? undefined;
  const transportMode = parsed.data.transportMode ?? currentTransportMode;
  if (transportMode === "webhook" && !webhookUrl) {
    return NextResponse.json({ error: "Webhook mode requires a webhook URL" }, { status: 400 });
  }

  if (parsed.data.botToken && binding.vaultSecretRef) {
    await vault.setSecret(binding.vaultSecretRef, parsed.data.botToken);
  }

  const updated = autonomyStore.upsertGatewayBinding({
    ...binding,
    name: parsed.data.name ?? binding.name,
    enabled: parsed.data.enabled ?? binding.enabled,
    target: parsed.data.target ?? binding.target,
    webhookSecret: parsed.data.webhookSecret === undefined
      ? binding.webhookSecret
      : parsed.data.webhookSecret ?? undefined,
    defaultThreadTitle: parsed.data.defaultThreadTitle === undefined
      ? binding.defaultThreadTitle
      : parsed.data.defaultThreadTitle ?? undefined,
    configJson: {
      ...binding.configJson,
      transportMode,
      ...(parsed.data.webhookUrl === undefined ? {} : { webhookUrl }),
    },
    updatedAt: new Date().toISOString(),
  });

  let webhookSyncError: string | undefined;
  try {
    await syncTelegramWebhook(updated.id);
  } catch (error) {
    webhookSyncError = error instanceof Error ? error.message : String(error);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "gateway",
    message: `Updated gateway binding ${updated.name}`,
    context: {
      bindingId: updated.id,
      webhookSyncError,
    },
  });

  return NextResponse.json({
    binding: redactBinding(updated),
    webhookSyncError,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const binding = autonomyStore.getGatewayBindingById(id);
  if (!binding) {
    return NextResponse.json({ error: "Binding not found" }, { status: 404 });
  }

  if (binding.vaultSecretRef) {
    await vault.deleteSecret(binding.vaultSecretRef);
  }
  autonomyStore.deleteGatewayBinding(id);
  await stateStore.addAction({
    actor: "user",
    kind: "gateway",
    message: `Deleted gateway binding ${binding.name}`,
    context: {
      bindingId: id,
    },
  });

  return NextResponse.json({ ok: true });
}
