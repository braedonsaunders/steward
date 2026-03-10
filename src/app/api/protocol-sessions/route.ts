import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { protocolSessionManager } from "@/lib/protocol-sessions/manager";
import { stateStore } from "@/lib/state/store";
import type { DeviceCredential, MqttBrokerRequest } from "@/lib/state/types";

export const runtime = "nodejs";

const mqttBrokerSchema = z.object({
  scheme: z.enum(["mqtt", "mqtts"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  clientId: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  clean: z.boolean().optional(),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  retain: z.boolean().optional(),
  subscribeTopics: z.array(z.string().min(1)).max(64).optional(),
  publishMessages: z.array(z.object({
    topic: z.string().min(1),
    payload: z.string().optional(),
    qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    retain: z.boolean().optional(),
  })).max(64).optional(),
  connectTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  responseTimeoutMs: z.number().int().min(250).max(120_000).optional(),
  collectMessages: z.number().int().min(0).max(50).optional(),
  keepaliveSec: z.number().int().min(5).max(1_200).optional(),
  expectRegex: z.string().min(1).optional(),
  successStrategy: z.enum(["auto", "transport", "response", "expectation"]).optional(),
  insecureSkipVerify: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  leaseTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
  arbitrationMode: z.enum(["shared", "exclusive", "single-connection"]).optional(),
  singleConnectionHint: z.boolean().optional(),
});

const createSessionSchema = z.object({
  deviceId: z.string().min(1),
  protocol: z.literal("mqtt"),
  broker: mqttBrokerSchema,
  credentialId: z.string().min(1).optional(),
  holder: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
});

function selectCredential(deviceId: string, credentialId?: string): DeviceCredential | undefined {
  const credentials = stateStore.getDeviceCredentials(deviceId)
    .filter((credential) => credential.protocol === "mqtt");
  if (credentialId) {
    return credentials.find((credential) => credential.id === credentialId);
  }
  const priority = ["validated", "provided", "invalid", "pending"] as const;
  return [...credentials].sort((a, b) => {
    const aPriority = priority.indexOf(a.status as (typeof priority)[number]);
    const bPriority = priority.indexOf(b.status as (typeof priority)[number]);
    if (aPriority !== bPriority) {
      return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  })[0];
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deviceId = request.nextUrl.searchParams.get("deviceId") ?? undefined;
  const protocol = request.nextUrl.searchParams.get("protocol") ?? undefined;
  return NextResponse.json({
    sessions: protocolSessionManager.listSessions({
      ...(deviceId ? { deviceId } : {}),
      ...(protocol === "mqtt" || protocol === "websocket" || protocol === "web-session" || protocol === "rdp" || protocol === "vnc" ? { protocol } : {}),
    }),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSessionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const credential = selectCredential(device.id, parsed.data.credentialId);
  const broker: MqttBrokerRequest = {
    protocol: "mqtt",
    ...parsed.data.broker,
  };

  try {
    const session = await protocolSessionManager.openPersistentMqttSession({
      device,
      broker,
      credentialId: credential?.id,
      credentialUsername: broker.username ?? credential?.accountLabel,
      holder: parsed.data.holder ?? `api:${device.id}`,
      purpose: parsed.data.purpose ?? "API persistent MQTT session",
      sessionId: broker.sessionId,
      arbitrationMode: broker.arbitrationMode,
      singleConnectionHint: broker.singleConnectionHint,
    });

    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to open persistent MQTT session" },
      { status: 409 },
    );
  }
}
