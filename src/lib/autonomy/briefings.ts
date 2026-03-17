import { autonomyStore } from "@/lib/autonomy/store";
import { stateStore } from "@/lib/state/store";

function formatWhen(value?: string): string {
  if (!value) {
    return "never";
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBullet(title: string, detail: string): string {
  return `- ${title}: ${detail}`;
}

export async function buildOperatorStatusText(): Promise<string> {
  const state = await stateStore.getState();
  const openInvestigations = autonomyStore.listInvestigations({
    status: ["open", "monitoring"],
  });
  const activeMissions = autonomyStore.listMissions({ status: "active" });
  const pendingApprovals = stateStore.getPendingApprovals();

  return [
    `Steward status`,
    `Devices: ${state.devices.length} total, ${state.devices.filter((device) => device.status === "online").length} online, ${state.devices.filter((device) => device.status === "offline").length} offline`,
    `Open incidents: ${state.incidents.filter((incident) => incident.status !== "resolved").length}`,
    `Open investigations: ${openInvestigations.length}`,
    `Pending approvals: ${pendingApprovals.length}`,
    `Active missions: ${activeMissions.length}`,
  ].join("\n");
}

export async function buildGlobalBriefing(options?: {
  missionId?: string;
  subagentId?: string;
}): Promise<{
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}> {
  const state = await stateStore.getState();
  const pendingApprovals = stateStore.getPendingApprovals();
  const missions = autonomyStore.listMissions().filter((mission) => {
    if (options?.missionId) {
      return mission.id === options.missionId;
    }
    if (options?.subagentId) {
      return mission.subagentId === options.subagentId;
    }
    return true;
  });
  const openInvestigations = autonomyStore.listInvestigations({
    status: ["open", "monitoring"],
    missionId: options?.missionId,
    subagentId: options?.subagentId,
  });
  const activeIncidents = state.incidents.filter((incident) => incident.status !== "resolved");
  const recommendations = state.recommendations.filter((recommendation) => !recommendation.dismissed);

  const incidentLines = activeIncidents.slice(0, 5).map((incident) =>
    formatBullet(incident.title, `${incident.severity}, ${incident.status}, ${incident.deviceIds.length} device(s)`),
  );
  const investigationLines = openInvestigations.slice(0, 5).map((investigation) =>
    formatBullet(investigation.title, `${investigation.severity}, ${investigation.status}, updated ${formatWhen(investigation.updatedAt)}`),
  );
  const missionLines = missions.slice(0, 6).map((mission) =>
    formatBullet(mission.title, `${mission.status}, last ${mission.lastStatus ?? "idle"}, next ${formatWhen(mission.nextRunAt)}`),
  );
  const approvalLines = pendingApprovals.slice(0, 5).map((approval) =>
    formatBullet(approval.name, `device ${approval.deviceId}, expires ${formatWhen(approval.expiresAt)}`),
  );
  const recommendationLines = recommendations.slice(0, 5).map((recommendation) =>
    formatBullet(recommendation.title, `${recommendation.priority} priority, ${recommendation.relatedDeviceIds.length} device(s)`),
  );

  const title = options?.missionId
    ? "Mission Briefing"
    : options?.subagentId
      ? "Subagent Briefing"
      : "Daily Steward Briefing";

  const body = [
    `# ${title}`,
    "",
    `Generated ${formatWhen(new Date().toISOString())}.`,
    "",
    "## Snapshot",
    formatBullet("Devices", `${state.devices.length} total, ${state.devices.filter((device) => device.status === "online").length} online, ${state.devices.filter((device) => device.status === "offline").length} offline`),
    formatBullet("Incidents", `${activeIncidents.length} open or in progress`),
    formatBullet("Investigations", `${openInvestigations.length} open or monitoring`),
    formatBullet("Approvals", `${pendingApprovals.length} awaiting operator input`),
    formatBullet("Missions", `${missions.filter((mission) => mission.status === "active").length} active in scope`),
    "",
    "## Incidents",
    ...(incidentLines.length > 0 ? incidentLines : ["- No active incidents."]),
    "",
    "## Investigations",
    ...(investigationLines.length > 0 ? investigationLines : ["- No open investigations."]),
    "",
    "## Approvals",
    ...(approvalLines.length > 0 ? approvalLines : ["- No pending approvals."]),
    "",
    "## Missions",
    ...(missionLines.length > 0 ? missionLines : ["- No missions in scope."]),
    "",
    "## Recommendations",
    ...(recommendationLines.length > 0 ? recommendationLines : ["- No outstanding recommendations."]),
  ].join("\n");

  return {
    title,
    body,
    metadata: {
      missionCount: missions.length,
      investigationCount: openInvestigations.length,
      incidentCount: activeIncidents.length,
      pendingApprovalCount: pendingApprovals.length,
      recommendationCount: recommendations.length,
    },
  };
}
