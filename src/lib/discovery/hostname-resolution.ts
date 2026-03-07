import type { Device, DiscoveryObservation } from "@/lib/state/types";

export interface HostnameResolutionStep {
  source: "stored" | "mdns" | "dhcp" | "router_lease";
  status: "resolved" | "hint" | "missing" | "available" | "unavailable";
  value?: string | null;
  values?: string[];
  detail: string;
}

export interface HostnameResolutionSummary {
  status: "resolved" | "unresolved";
  hostname: string | null;
  resolvedBy: "stored" | "dhcp" | null;
  attemptOrder: Array<HostnameResolutionStep["source"]>;
  mdnsHints: string[];
  dhcpHostnames: string[];
  steps: HostnameResolutionStep[];
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  ));
}

function listSummary(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(", ") : fallback;
}

export function buildHostnameResolutionSummary(
  device: Pick<Device, "hostname" | "metadata">,
  observations: DiscoveryObservation[],
  routerCandidates: Array<Record<string, unknown>> = [],
): HostnameResolutionSummary {
  const metadata = isRecord(device.metadata) ? device.metadata : {};
  const storedHostname = typeof device.hostname === "string" && device.hostname.trim().length > 0
    ? device.hostname.trim()
    : null;
  const mdnsHints = uniqueStrings([
    typeof metadata.mdnsFriendlyName === "string" ? metadata.mdnsFriendlyName : undefined,
    typeof metadata.ssdpFriendlyName === "string" ? metadata.ssdpFriendlyName : undefined,
  ]);
  const dhcpHostnames = uniqueStrings(observations.flatMap((observation) => {
    if (observation.evidenceType !== "dhcp_lease") {
      return [];
    }
    const details = observation.details;
    const hostnames = Array.isArray(details.hostnames)
      ? details.hostnames.filter((value): value is string => typeof value === "string")
      : [];
    return [
      typeof details.hostname === "string" ? details.hostname : undefined,
      ...hostnames,
    ];
  }));

  const leaseCapableRouters = routerCandidates.filter((candidate) => candidate.hasRouterLeaseIntel === true);
  const routerNames = uniqueStrings(leaseCapableRouters.map((candidate) =>
    typeof candidate.name === "string" ? candidate.name : undefined,
  ));

  const resolvedBy: HostnameResolutionSummary["resolvedBy"] = storedHostname
    ? "stored"
    : dhcpHostnames[0]
      ? "dhcp"
      : null;
  const hostname = storedHostname ?? dhcpHostnames[0] ?? null;

  const steps: HostnameResolutionStep[] = [
    {
      source: "stored",
      status: storedHostname ? "resolved" : "missing",
      value: storedHostname,
      detail: storedHostname
        ? `Steward already has a stored hostname: ${storedHostname}.`
        : "No stored discovery hostname is currently attached to this device.",
    },
    {
      source: "mdns",
      status: mdnsHints.length > 0 ? "hint" : "missing",
      values: mdnsHints,
      detail: mdnsHints.length > 0
        ? `mDNS/Bonjour exposed name hints: ${mdnsHints.join(", ")}.`
        : "No mDNS/Bonjour hostname or friendly-name hint has been captured.",
    },
    {
      source: "dhcp",
      status: dhcpHostnames.length > 0 ? "resolved" : "missing",
      values: dhcpHostnames,
      detail: dhcpHostnames.length > 0
        ? `DHCP lease hints reported hostname(s): ${dhcpHostnames.join(", ")}.`
        : "No DHCP lease hostname has been observed for this device.",
    },
    {
      source: "router_lease",
      status: leaseCapableRouters.length > 0
        ? "available"
        : routerCandidates.length > 0
          ? "available"
          : "unavailable",
      values: routerNames,
      detail: leaseCapableRouters.length > 0
        ? `Router lease correlation is available via ${listSummary(routerNames, "candidate gateways")}.`
        : routerCandidates.length > 0
          ? "Gateway candidates exist, but Steward does not yet have a lease-intel capable router binding for them."
          : "No router/gateway candidate is available for lease-table correlation.",
    },
  ];

  const summary = hostname
    ? resolvedBy === "stored"
      ? `Hostname resolved from Steward's stored discovery state: ${hostname}.`
      : `Hostname resolved from DHCP lease evidence: ${hostname}.`
    : leaseCapableRouters.length > 0
      ? "Stored discovery, mDNS, and DHCP do not confirm a hostname yet. Router lease lookup is available as the next source."
      : "Stored discovery, mDNS, and DHCP do not confirm a hostname yet, and no router lease source is currently available.";

  return {
    status: hostname ? "resolved" : "unresolved",
    hostname,
    resolvedBy,
    attemptOrder: ["stored", "mdns", "dhcp", "router_lease"],
    mdnsHints,
    dhcpHostnames,
    steps,
    summary,
  };
}
