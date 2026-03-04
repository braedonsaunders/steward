import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const schema = z.object({
  agentIntervalMs: z.number().int().min(15_000).max(15 * 60 * 1000),
  deepScanIntervalMs: z.number().int().min(5 * 60 * 1000).max(24 * 60 * 60 * 1000),
  incrementalActiveTargets: z.number().int().min(8).max(512),
  deepActiveTargets: z.number().int().min(16).max(1024),
  incrementalPortScanHosts: z.number().int().min(4).max(256),
  deepPortScanHosts: z.number().int().min(8).max(1024),
  llmDiscoveryLimit: z.number().int().min(1).max(100),
  incrementalFingerprintTargets: z.number().int().min(1).max(100),
  deepFingerprintTargets: z.number().int().min(1).max(200),
  enableMdnsDiscovery: z.boolean(),
  enableSsdpDiscovery: z.boolean(),
  enableSnmpProbe: z.boolean(),
  ouiUpdateIntervalMs: z.number().int().min(60 * 60 * 1000).max(30 * 24 * 60 * 60 * 1000),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ settings: stateStore.getRuntimeSettings() });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  if (data.deepActiveTargets < data.incrementalActiveTargets) {
    return NextResponse.json(
      { error: "deepActiveTargets must be greater than or equal to incrementalActiveTargets" },
      { status: 400 },
    );
  }
  if (data.deepPortScanHosts < data.incrementalPortScanHosts) {
    return NextResponse.json(
      { error: "deepPortScanHosts must be greater than or equal to incrementalPortScanHosts" },
      { status: 400 },
    );
  }

  stateStore.setRuntimeSettings(data);
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: "Updated runtime discovery settings",
    context: data,
  });

  return NextResponse.json({ ok: true, settings: stateStore.getRuntimeSettings() });
}
