import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const schema = z.object({
  scannerIntervalMs: z.number().int().min(15_000).max(15 * 60 * 1000),
  agentWakeIntervalMs: z.number().int().min(30_000).max(24 * 60 * 60 * 1000),
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
  enableAdvancedNmapFingerprint: z.boolean(),
  nmapFingerprintTimeoutMs: z.number().int().min(5_000).max(5 * 60 * 1000),
  incrementalNmapTargets: z.number().int().min(1).max(128),
  deepNmapTargets: z.number().int().min(1).max(512),
  enablePacketIntel: z.boolean(),
  packetIntelDurationSec: z.number().int().min(1).max(60),
  packetIntelMaxPackets: z.number().int().min(100).max(50_000),
  packetIntelTopTalkers: z.number().int().min(1).max(100),
  enableBrowserObservation: z.boolean(),
  browserObservationTimeoutMs: z.number().int().min(2_000).max(120_000),
  incrementalBrowserObservationTargets: z.number().int().min(1).max(64),
  deepBrowserObservationTargets: z.number().int().min(1).max(256),
  browserObservationCaptureScreenshots: z.boolean(),
  enableWebResearch: z.boolean(),
  webResearchProvider: z.enum(["brave_scrape", "duckduckgo_scrape", "brave_api", "serper", "serpapi"]),
  webResearchFallbackStrategy: z.enum(["prefer_non_key", "key_only", "selected_only"]),
  webResearchTimeoutMs: z.number().int().min(3_000).max(60_000),
  webResearchMaxResults: z.number().int().min(1).max(80),
  webResearchDeepReadPages: z.number().int().min(0).max(40),
  enableDhcpLeaseIntel: z.boolean(),
  dhcpLeaseCommandTimeoutMs: z.number().int().min(1_000).max(60_000),
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
  availabilityScannerAlertsEnabled: z.boolean(),
  securityScannerAlertsEnabled: z.boolean(),
  serviceContractScannerAlertsEnabled: z.boolean(),
  ignoredIncidentTypes: z.array(z.string().trim().min(1).max(120)).max(100),
  localToolInstallPolicy: z.enum(["require_approval", "allow_safe", "allow_all", "deny"]),
  localToolExecutionPolicy: z.enum(["require_approval", "allow_safe", "allow_all", "deny"]),
  localToolApprovalTtlMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000),
  localToolHealthCheckIntervalMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60 * 1000),
  localToolAutoInstallBuiltins: z.boolean(),
  protocolSessionSweepIntervalMs: z.number().int().min(1_000).max(10 * 60 * 1000),
  protocolSessionDefaultLeaseTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000),
  protocolSessionMaxLeaseTtlMs: z.number().int().min(10_000).max(7 * 24 * 60 * 60 * 1000),
  protocolSessionMessageRetentionLimit: z.number().int().min(10).max(10_000),
  protocolSessionReconnectBaseMs: z.number().int().min(100).max(5 * 60 * 1000),
  protocolSessionReconnectMaxMs: z.number().int().min(500).max(30 * 60 * 1000),
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
  if (data.agentWakeIntervalMs < data.scannerIntervalMs) {
    return NextResponse.json(
      { error: "agentWakeIntervalMs must be greater than or equal to scannerIntervalMs" },
      { status: 400 },
    );
  }
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
  if (data.deepNmapTargets < data.incrementalNmapTargets) {
    return NextResponse.json(
      { error: "deepNmapTargets must be greater than or equal to incrementalNmapTargets" },
      { status: 400 },
    );
  }
  if (data.deepBrowserObservationTargets < data.incrementalBrowserObservationTargets) {
    return NextResponse.json(
      { error: "deepBrowserObservationTargets must be greater than or equal to incrementalBrowserObservationTargets" },
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
  if (data.protocolSessionDefaultLeaseTtlMs > data.protocolSessionMaxLeaseTtlMs) {
    return NextResponse.json(
      { error: "protocolSessionDefaultLeaseTtlMs must be less than or equal to protocolSessionMaxLeaseTtlMs" },
      { status: 400 },
    );
  }
  if (data.protocolSessionReconnectBaseMs > data.protocolSessionReconnectMaxMs) {
    return NextResponse.json(
      { error: "protocolSessionReconnectBaseMs must be less than or equal to protocolSessionReconnectMaxMs" },
      { status: 400 },
    );
  }

  stateStore.setRuntimeSettings({
    ...data,
    ignoredIncidentTypes: Array.from(new Set(data.ignoredIncidentTypes)),
  });
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: "Updated runtime settings",
    context: data,
  });

  return NextResponse.json({ ok: true, settings: stateStore.getRuntimeSettings() });
}
