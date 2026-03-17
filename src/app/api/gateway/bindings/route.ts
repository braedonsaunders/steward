export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { syncTelegramWebhook } from "@/lib/autonomy/gateway";
import { autonomyStore } from "@/lib/autonomy/store";
import type { GatewayBindingRecord } from "@/lib/autonomy/types";
import { vault } from "@/lib/security/vault";
import { stateStore } from "@/lib/state/store";

const BindingCreateSchema = z.object({
  name: z.string().min(2),
  enabled: z.boolean().optional().default(true),
  target: z.string().optional().default(""),
  botToken: z.string().optional(),
  webhookSecret: z.string().optional(),
  defaultThreadTitle: z.string().optional(),
  transportMode: z.enum(["polling", "webhook"]).optional(),
  webhookUrl: z.string().url().optional(),
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

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    bindings: autonomyStore.listGatewayBindings().map(redactBinding),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = BindingCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const transportMode = parsed.data.transportMode ?? (parsed.data.webhookUrl ? "webhook" : "polling");
  if (transportMode === "webhook" && !parsed.data.webhookUrl) {
    return NextResponse.json({ error: "Webhook mode requires a webhook URL" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const vaultSecretRef = parsed.data.botToken ? `gateway.telegram.${id}.token` : undefined;

  if (parsed.data.botToken && vaultSecretRef) {
    await vault.setSecret(vaultSecretRef, parsed.data.botToken);
  }

  const binding: GatewayBindingRecord = {
    id,
    kind: "telegram",
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    target: parsed.data.target,
    vaultSecretRef,
    webhookSecret: parsed.data.webhookSecret,
    defaultThreadTitle: parsed.data.defaultThreadTitle,
    configJson: {
      transportMode,
      webhookUrl: parsed.data.webhookUrl,
      pollingUpdateOffset: 0,
    },
    createdAt: now,
    updatedAt: now,
  };

  autonomyStore.upsertGatewayBinding(binding);

  let webhookSyncError: string | undefined;
  try {
    await syncTelegramWebhook(binding.id);
  } catch (error) {
    webhookSyncError = error instanceof Error ? error.message : String(error);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "gateway",
    message: `Created gateway binding ${binding.name}`,
    context: {
      bindingId: binding.id,
      webhookSyncError,
    },
  });

  return NextResponse.json({
    binding: redactBinding(binding),
    webhookSyncError,
  }, { status: 201 });
}
