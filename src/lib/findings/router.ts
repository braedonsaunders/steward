import { randomUUID } from "node:crypto";
import { enqueueNotificationEvent } from "@/lib/notifications/manager";
import { stateStore } from "@/lib/state/store";
import type { DeviceFinding, FindingOccurrence, Incident, IncidentSeverity } from "@/lib/state/types";

const incidentKey = (incident: Incident): string =>
  String(incident.metadata.key ?? `${incident.severity}:${incident.title}:${incident.deviceIds.join(",")}`);

const upsertIncident = (
  incidents: Incident[],
  incoming: Omit<Incident, "id" | "detectedAt" | "updatedAt" | "timeline" | "autoRemediated">,
): { next: Incident[]; opened: boolean; incident: Incident } => {
  const key = String(incoming.metadata.key ?? `${incoming.severity}:${incoming.title}:${incoming.deviceIds.join(",")}`);
  const idx = incidents.findIndex((incident) => incidentKey(incident) === key);

  if (idx === -1) {
    const createdAt = new Date().toISOString();
    const created: Incident = {
      id: randomUUID(),
      detectedAt: createdAt,
      updatedAt: createdAt,
      timeline: [
        {
          at: createdAt,
          message: "Detected by Steward",
        },
      ],
      autoRemediated: false,
      ...incoming,
    };

    return { next: [created, ...incidents], opened: true, incident: created };
  }

  const existing = incidents[idx];
  const reopened = existing.status === "resolved" && incoming.status !== "resolved";
  const unchanged =
    existing.title === incoming.title &&
    existing.summary === incoming.summary &&
    existing.severity === incoming.severity &&
    existing.status === incoming.status;

  const now = Date.now();
  const lastEventAt = new Date(existing.timeline[0]?.at ?? existing.updatedAt).getTime();
  const shouldAppendHeartbeat = now - lastEventAt >= 15 * 60 * 1000;
  const updatedAt = unchanged && !shouldAppendHeartbeat && !reopened
    ? existing.updatedAt
    : new Date().toISOString();

  const updated: Incident = {
    ...existing,
    ...incoming,
    updatedAt,
    timeline: reopened
      ? [{ at: updatedAt, message: "Incident reopened" }, ...existing.timeline].slice(0, 30)
      : shouldAppendHeartbeat
        ? [{ at: updatedAt, message: "Incident condition persisted" }, ...existing.timeline].slice(0, 30)
        : existing.timeline,
  };

  const next = [...incidents];
  next[idx] = updated;
  return { next, opened: reopened, incident: updated };
};

const resolveIncidentByKey = (
  incidents: Incident[],
  key: string,
  message: string,
): { next: Incident[]; resolved: boolean; incident: Incident | null } => {
  const now = new Date().toISOString();
  let resolved = false;
  let resolvedIncident: Incident | null = null;

  const next = incidents.map((incident) => {
    const incidentKeyValue = String(incident.metadata.key ?? "");
    if (incidentKeyValue !== key || incident.status === "resolved") {
      return incident;
    }
    resolved = true;
    resolvedIncident = {
      ...incident,
      status: "resolved",
      updatedAt: now,
      timeline: [
        { at: now, message },
        ...incident.timeline,
      ].slice(0, 30),
    };
    return resolvedIncident;
  });

  return { next, resolved, incident: resolvedIncident };
};

export interface FindingIncidentInput {
  title: string;
  summary: string;
  severity: IncidentSeverity;
  diagnosis?: string;
  remediationPlan?: string;
  metadata?: Record<string, unknown>;
  notifyOnOpen?: boolean;
  resolveMessage?: string;
}

export interface RouteFindingInput {
  incidents: Incident[];
  source: string;
  finding: Omit<DeviceFinding, "id" | "firstSeenAt" | "lastSeenAt">;
  occurrenceMetadata?: Record<string, unknown>;
  incident?: FindingIncidentInput | null;
}

export interface RouteFindingResult {
  incidents: Incident[];
  finding: DeviceFinding;
  incident: Incident | null;
  incidentOpened: boolean;
  incidentResolved: boolean;
}

export async function routeFinding(input: RouteFindingInput): Promise<RouteFindingResult> {
  const finding = stateStore.upsertDeviceFindingByDedupe(input.finding);
  let nextIncidents = input.incidents;
  let nextIncident: Incident | null = null;
  let incidentOpened = false;
  let incidentResolved = false;

  if (input.incident) {
    const incidentMetadata = {
      key: input.finding.dedupeKey,
      ...input.incident.metadata,
    };

    if (input.finding.status === "resolved") {
      const resolution = resolveIncidentByKey(
        nextIncidents,
        String(incidentMetadata.key),
        input.incident.resolveMessage ?? `Condition recovered: ${input.finding.title}`,
      );
      nextIncidents = resolution.next;
      nextIncident = resolution.incident;
      incidentResolved = resolution.resolved;
    } else {
      const upserted = upsertIncident(nextIncidents, {
        title: input.incident.title,
        summary: input.incident.summary,
        severity: input.incident.severity,
        deviceIds: [input.finding.deviceId],
        status: "open",
        diagnosis: input.incident.diagnosis,
        remediationPlan: input.incident.remediationPlan,
        metadata: incidentMetadata,
      });
      nextIncidents = upserted.next;
      nextIncident = upserted.incident;
      incidentOpened = upserted.opened;

      if (incidentOpened && input.incident.notifyOnOpen) {
        await enqueueNotificationEvent({
          kind: "incident.opened",
          eventRef: upserted.incident.id,
          dedupeKey: `incident-opened:${upserted.incident.id}`,
          title: `Incident opened: ${upserted.incident.title}`,
          body: upserted.incident.summary,
          severity: upserted.incident.severity,
          metadata: {
            deviceId: input.finding.deviceId,
            ...incidentMetadata,
          },
        });
      }
    }
  }

  const occurrence: FindingOccurrence = {
    id: randomUUID(),
    findingId: finding.id,
    deviceId: finding.deviceId,
    dedupeKey: finding.dedupeKey,
    findingType: finding.findingType,
    severity: finding.severity,
    status: finding.status,
    summary: finding.summary,
    evidenceJson: finding.evidenceJson,
    source: input.source,
    observedAt: new Date().toISOString(),
    metadataJson: {
      incidentId: nextIncident?.id,
      incidentOpened,
      incidentResolved,
      ...(input.occurrenceMetadata ?? {}),
    },
  };
  stateStore.appendFindingOccurrence(occurrence);

  return {
    incidents: nextIncidents,
    finding,
    incident: nextIncident,
    incidentOpened,
    incidentResolved,
  };
}
