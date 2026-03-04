import { randomUUID } from "node:crypto";
import { stateStore } from "@/lib/state/store";
import type { DailyDigest } from "@/lib/state/types";

export async function generateDigest(since?: Date): Promise<DailyDigest> {
  const now = new Date();
  const periodEnd = now.toISOString();
  const periodStart = since
    ? since.toISOString()
    : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const state = await stateStore.getState();

  // Overnight incidents (detected in period)
  const overnightIncidents = state.incidents
    .filter((i) => i.detectedAt >= periodStart && i.detectedAt <= periodEnd)
    .slice(0, 20)
    .map((i) => ({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      autoRemediated: i.autoRemediated,
    }));

  // New risks
  const newRisks: DailyDigest["newRisks"] = [];

  // Cert expiry risks
  const certRecs = state.recommendations.filter(
    (r) => !r.dismissed && r.title.toLowerCase().includes("tls") && r.createdAt >= periodStart,
  );
  if (certRecs.length > 0) {
    newRisks.push({
      type: "cert-expiry",
      description: `${certRecs.length} TLS certificate lifecycle warning(s)`,
      deviceIds: certRecs.flatMap((r) => r.relatedDeviceIds),
    });
  }

  // Backup risks
  const backupIncidents = state.incidents.filter(
    (i) => i.status !== "resolved" && i.title.toLowerCase().includes("backup"),
  );
  if (backupIncidents.length > 0) {
    newRisks.push({
      type: "backup-failure",
      description: `${backupIncidents.length} backup issue(s) unresolved`,
      deviceIds: backupIncidents.flatMap((i) => i.deviceIds),
    });
  }

  // Pending approvals
  const pendingApprovals = stateStore.getPendingApprovals().slice(0, 10).map((r) => ({
    id: r.id,
    summary: `${r.name} on device ${r.deviceId}`,
    expiresAt: r.expiresAt ?? "",
  }));

  // Top recommendations
  const topRecommendations = state.recommendations
    .filter((r) => !r.dismissed)
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
    })
    .slice(0, 3)
    .map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      impact: r.impact,
    }));

  // Stats
  const devicesOnline = state.devices.filter((d) => d.status === "online").length;
  const devicesOffline = state.devices.filter((d) => d.status === "offline").length;
  const incidentsOpened = state.incidents.filter(
    (i) => i.detectedAt >= periodStart && i.detectedAt <= periodEnd,
  ).length;
  const incidentsResolved = state.incidents.filter(
    (i) => i.status === "resolved" && i.updatedAt >= periodStart && i.updatedAt <= periodEnd,
  ).length;

  const playbookRuns = stateStore.getPlaybookRuns({});
  const periodRuns = playbookRuns.filter(
    (r) => r.createdAt >= periodStart && r.createdAt <= periodEnd,
  );
  const playbooksRun = periodRuns.length;
  const playbooksSucceeded = periodRuns.filter((r) => r.status === "completed").length;

  const digest: DailyDigest = {
    id: randomUUID(),
    generatedAt: now.toISOString(),
    periodStart,
    periodEnd,
    overnightIncidents,
    newRisks,
    pendingApprovals,
    topRecommendations,
    stats: {
      devicesOnline,
      devicesOffline,
      incidentsOpened,
      incidentsResolved,
      playbooksRun,
      playbooksSucceeded,
    },
  };

  stateStore.addDigest(digest);

  await stateStore.addAction({
    actor: "steward",
    kind: "digest",
    message: `Daily digest generated for ${periodStart.split("T")[0]}`,
    context: { digestId: digest.id },
  });

  return digest;
}
