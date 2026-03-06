import type { Incident } from "@/lib/state/types";

const INCIDENT_TYPE_BY_KEY_PREFIX: Record<string, string> = {
  offline: "availability.offline",
  telnet: "security.telnet-exposure",
  "service-contract": "service-contract.failure",
  assurance: "assurance.failure",
};

export function getIncidentType(incident: Incident): string | null {
  const explicitType = typeof incident.metadata.incidentType === "string"
    ? incident.metadata.incidentType.trim()
    : "";
  if (explicitType.length > 0) {
    return explicitType;
  }

  const key = typeof incident.metadata.key === "string" ? incident.metadata.key.trim() : "";
  if (key.length === 0) {
    return null;
  }

  const prefix = key.split(":")[0]?.trim().toLowerCase();
  if (!prefix) {
    return null;
  }

  return INCIDENT_TYPE_BY_KEY_PREFIX[prefix] ?? prefix;
}

export function formatIncidentType(incidentType: string | null): string {
  if (!incidentType) {
    return "Unknown";
  }

  switch (incidentType) {
    case "availability.offline":
      return "Availability (Offline)";
    case "security.telnet-exposure":
      return "Security (Telnet Exposure)";
    case "assurance.failure":
    case "service-contract.failure":
      return "Assurance Failure";
    default:
      return incidentType;
  }
}
