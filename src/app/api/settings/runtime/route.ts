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
  laneBEnabled: z.boolean(),
  laneBAllowedEnvironments: z.array(z.enum(["prod", "staging", "dev", "lab"])).max(4),
  laneBAllowedFamilies: z.array(z.string().min(1)).max(50),
  laneCMutationsInLab: z.boolean(),
  laneCMutationsInProd: z.boolean(),
  mutationRequireDryRunWhenSupported: z.boolean(),
  approvalTtlClassBMs: z.number().int().min(60_000).max(12 * 60 * 60 * 1000),
  approvalTtlClassCMs: z.number().int().min(60_000).max(12 * 60 * 60 * 1000),
  approvalTtlClassDMs: z.number().int().min(60_000).max(12 * 60 * 60 * 1000),
  quarantineThresholdCount: z.number().int().min(1).max(20),
  quarantineThresholdWindowMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asOf = request.nextUrl.searchParams.get("asOf") ?? undefined;
  if (asOf && Number.isNaN(Date.parse(asOf))) {
    return NextResponse.json({ error: "Invalid asOf timestamp" }, { status: 400 });
  }

  return NextResponse.json({ settings: stateStore.getRuntimeSettings(asOf), asOf: asOf ?? null });
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
  if (data.laneCMutationsInProd) {
    return NextResponse.json(
      { error: "Lane C mutable mode is not allowed in production" },
      { status: 400 },
    );
  }
  if (data.approvalTtlClassDMs > data.approvalTtlClassCMs || data.approvalTtlClassCMs > data.approvalTtlClassBMs) {
    return NextResponse.json(
      { error: "Approval TTLs must satisfy D <= C <= B" },
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
