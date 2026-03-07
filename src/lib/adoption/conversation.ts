import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { ChatMessage, ChatSession, Device, DiscoveryObservation } from "@/lib/state/types";

export const ONBOARDING_TITLE_PREFIX = "[Onboarding]";

export interface OnboardingAssuranceProposal {
  id: string;
  displayName: string;
  assuranceKey: string;
  serviceKey: string;
  criticality: "low" | "medium" | "high";
  checkIntervalSec: number;
  requiredProtocols: string[];
  monitorType: string;
  rationale: string;
}

export type OnboardingContractProposal = OnboardingAssuranceProposal;

export interface OnboardingSynthesis {
  summary: string;
  responsibilities: string[];
  credentialRequests: Array<{ protocol: string; reason: string; priority: "high" | "medium" | "low" }>;
  assurances: OnboardingAssuranceProposal[];
  contracts: OnboardingAssuranceProposal[];
  nextActions: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, limit);
}

function normalizeProposal(raw: Record<string, unknown>, idx: number): OnboardingAssuranceProposal | null {
  const displayName = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  if (!displayName) return null;
  const assuranceKey = typeof raw.assuranceKey === "string" && raw.assuranceKey.trim().length > 0
    ? raw.assuranceKey.trim()
    : typeof raw.serviceKey === "string" && raw.serviceKey.trim().length > 0
      ? raw.serviceKey.trim()
    : displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const criticality = raw.criticality === "high" || raw.criticality === "low" ? raw.criticality : "medium";
  const checkIntervalRaw = Number(raw.checkIntervalSec);
  const checkIntervalSec = Number.isFinite(checkIntervalRaw)
    ? Math.max(15, Math.min(3600, Math.floor(checkIntervalRaw)))
    : 120;
  const requiredProtocols = toStringArray(raw.requiredProtocols, 8).map((value) => value.toLowerCase());
  const monitorType = typeof raw.monitorType === "string" && raw.monitorType.trim().length > 0
    ? raw.monitorType.trim()
    : "process_health";
  const rationale = typeof raw.rationale === "string" && raw.rationale.trim().length > 0
    ? raw.rationale.trim()
    : "Proposed from onboarding conversation and telemetry evidence.";
  return {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : `${assuranceKey}:${idx}`,
    displayName,
    assuranceKey,
    serviceKey: assuranceKey,
    criticality,
    checkIntervalSec,
    requiredProtocols,
    monitorType,
    rationale,
  };
}

export function isOnboardingSession(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return session.title.startsWith(ONBOARDING_TITLE_PREFIX);
}

export function getOnboardingSession(deviceId: string): ChatSession | null {
  const sessions = stateStore.getChatSessions();
  return sessions.find((session) => session.deviceId === deviceId && isOnboardingSession(session)) ?? null;
}

export function ensureOnboardingSession(device: Device): ChatSession {
  const existing = getOnboardingSession(device.id);
  if (existing) return existing;

  const now = nowIso();
  const session: ChatSession = {
    id: randomUUID(),
    title: `${ONBOARDING_TITLE_PREFIX} ${device.name}`,
    deviceId: device.id,
    createdAt: now,
    updatedAt: now,
  };
  stateStore.createChatSession(session);

  return session;
}

function sameSubnet24(a: string, b: string): boolean {
  const aParts = a.split(".");
  const bParts = b.split(".");
  return aParts.length === 4 && bParts.length === 4
    && aParts[0] === bParts[0]
    && aParts[1] === bParts[1]
    && aParts[2] === bParts[2];
}

function deviceLooksLikeGateway(device: Device): boolean {
  if (["router", "firewall", "modem", "access-point"].includes(device.type)) {
    return true;
  }

  const ports = new Set(device.services.map((service) => service.port));
  const identityText = `${device.name} ${device.hostname ?? ""} ${device.vendor ?? ""}`.toLowerCase();
  return /\b(router|gateway|firewall|pfsense|opnsense|unifi|dream machine|mikrotik)\b/.test(identityText)
    || ((ports.has(53) || ports.has(67)) && (ports.has(80) || ports.has(443)));
}

function summarizeObservation(observation: DiscoveryObservation): string {
  const details = observation.details;

  if (observation.evidenceType === "dhcp_lease") {
    const hostname = typeof details.hostname === "string" ? details.hostname : undefined;
    const hostnames = Array.isArray(details.hostnames)
      ? details.hostnames.filter((value): value is string => typeof value === "string").slice(0, 3)
      : [];
    return hostname
      ? `DHCP hostname ${hostname}`
      : hostnames.length > 0
        ? `DHCP hostnames ${hostnames.join(", ")}`
        : "DHCP lease hint";
  }

  if (observation.evidenceType === "packet_traffic_profile") {
    const dnsNames = Array.isArray(details.dnsNames)
      ? details.dnsNames.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const httpHosts = Array.isArray(details.httpHosts)
      ? details.httpHosts.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const tlsSni = Array.isArray(details.tlsSni)
      ? details.tlsSni.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const parts = [
      dnsNames.length > 0 ? `dns=${dnsNames.join(",")}` : "",
      httpHosts.length > 0 ? `http=${httpHosts.join(",")}` : "",
      tlsSni.length > 0 ? `tls=${tlsSni.join(",")}` : "",
    ].filter((part) => part.length > 0);
    return parts.length > 0 ? `Traffic hints ${parts.join(" ")}` : "Traffic profile";
  }

  if (observation.evidenceType === "browser_observation") {
    const title = typeof details.title === "string" ? details.title : undefined;
    const url = typeof details.finalUrl === "string"
      ? details.finalUrl
      : typeof details.url === "string"
        ? details.url
        : undefined;
    const vendorHints = Array.isArray(details.vendorHints)
      ? details.vendorHints.filter((value): value is string => typeof value === "string").slice(0, 2)
      : [];
    const parts = [title, vendorHints.length > 0 ? vendorHints.join(", ") : "", url].filter(Boolean);
    return parts.length > 0 ? `Browser ${parts.join(" | ")}` : "Browser observation";
  }

  if (observation.evidenceType === "favicon_hash") {
    const hash = typeof details.hash === "string" ? details.hash : "";
    return hash ? `Favicon hash ${hash.slice(0, 16)}` : "Favicon hash";
  }

  if (observation.evidenceType === "protocol_hint") {
    const protocol = typeof details.protocol === "string" ? details.protocol : "unknown";
    const port = typeof details.port === "number" ? details.port : "";
    return `Protocol hint ${protocol}${port ? ` on ${port}` : ""}`;
  }

  if (observation.evidenceType === "nmap_script") {
    const scriptId = typeof details.scriptId === "string" ? details.scriptId : "script";
    const port = typeof details.port === "number" ? details.port : "";
    return `Nmap ${scriptId}${port ? ` on ${port}` : ""}`;
  }

  if (observation.evidenceType === "http_banner") {
    const title = typeof details.title === "string" ? details.title : undefined;
    return title ? `HTTP title ${title}` : "HTTP banner";
  }

  return observation.evidenceType.replace(/_/g, " ");
}

async function buildOnboardingLocalContext(device: Device): Promise<{
  identity: Record<string, unknown>;
  routerCandidates: Array<Record<string, unknown>>;
}> {
  const ips = [device.ip, ...(device.secondaryIps ?? [])].filter((value, index, all) => all.indexOf(value) === index);
  const sinceAt = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  const grouped = stateStore.getRecentDiscoveryObservationsByIp(ips, { sinceAt, limitPerIp: 8 });
  const observations = Array.from(grouped.values())
    .flat()
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, 8);

  const dhcpHostnames = new Set<string>();
  const dnsNames = new Set<string>();
  const httpHosts = new Set<string>();
  const tlsSni = new Set<string>();
  const faviconHashes = new Set<string>();
  const protocolHints = new Set<string>();

  for (const observation of observations) {
    const details = observation.details;
    if (observation.evidenceType === "dhcp_lease") {
      if (typeof details.hostname === "string") dhcpHostnames.add(details.hostname);
      if (Array.isArray(details.hostnames)) {
        for (const value of details.hostnames) {
          if (typeof value === "string") dhcpHostnames.add(value);
        }
      }
    }
    if (observation.evidenceType === "packet_traffic_profile") {
      for (const key of ["dnsNames", "httpHosts", "tlsSni"] as const) {
        const values = details[key];
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (typeof value !== "string") continue;
          if (key === "dnsNames") dnsNames.add(value);
          if (key === "httpHosts") httpHosts.add(value);
          if (key === "tlsSni") tlsSni.add(value);
        }
      }
    }
    if (observation.evidenceType === "favicon_hash" && typeof details.hash === "string") {
      faviconHashes.add(details.hash);
    }
    if (observation.evidenceType === "protocol_hint" && typeof details.protocol === "string") {
      protocolHints.add(details.protocol);
    }
  }

  const state = await stateStore.getState();
  const routerCandidates = state.devices
    .filter((candidate) => candidate.id !== device.id && deviceLooksLikeGateway(candidate))
    .sort((a, b) => {
      const subnetScore = Number(sameSubnet24(b.ip, device.ip)) - Number(sameSubnet24(a.ip, device.ip));
      if (subnetScore !== 0) return subnetScore;
      const typeScore = Number(b.type === "router" || b.type === "firewall") - Number(a.type === "router" || a.type === "firewall");
      if (typeScore !== 0) return typeScore;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 4)
    .map((candidate) => {
      const routerLeaseIntel = isRecord(candidate.metadata.routerLeaseIntel) ? candidate.metadata.routerLeaseIntel : {};
      return {
        deviceId: candidate.id,
        name: candidate.name,
        ip: candidate.ip,
        type: candidate.type,
        vendor: candidate.vendor ?? null,
        hostname: candidate.hostname ?? null,
        services: candidate.services.slice(0, 6).map((service) => `${service.name}:${service.port}`),
        sameSubnet24: sameSubnet24(candidate.ip, device.ip),
        hasRouterLeaseIntel: Object.keys(routerLeaseIntel).length > 0,
        preferredLeaseEndpoint: typeof routerLeaseIntel.preferredLeaseEndpoint === "string"
          ? routerLeaseIntel.preferredLeaseEndpoint
          : null,
      };
    });

  const discovery = isRecord(device.metadata.discovery) ? device.metadata.discovery : {};
  const classification = isRecord(device.metadata.classification) ? device.metadata.classification : {};
  const browserObservation = isRecord(device.metadata.browserObservation) ? device.metadata.browserObservation : {};
  const fingerprint = isRecord(device.metadata.fingerprint) ? device.metadata.fingerprint : {};

  return {
    identity: {
      deviceId: device.id,
      name: device.name,
      ip: device.ip,
      secondaryIps: device.secondaryIps ?? [],
      mac: device.mac ?? null,
      hostname: device.hostname ?? null,
      vendor: device.vendor ?? null,
      os: device.os ?? null,
      type: device.type,
      status: device.status,
      protocols: device.protocols.slice(0, 10),
      services: device.services.slice(0, 10).map((service) => ({
        name: service.name,
        port: service.port,
        transport: service.transport,
        secure: service.secure,
        product: service.product ?? null,
      })),
      discovery: {
        confidence: typeof discovery.confidence === "number" ? discovery.confidence : null,
        evidenceTypes: Array.isArray(discovery.evidenceTypes)
          ? discovery.evidenceTypes.filter((value): value is string => typeof value === "string").slice(0, 10)
          : [],
        observationCount: typeof discovery.observationCount === "number" ? discovery.observationCount : null,
      },
      classification: {
        confidence: typeof classification.confidence === "number" ? classification.confidence : null,
        signals: Array.isArray(classification.signals)
          ? classification.signals
            .filter((value): value is Record<string, unknown> => isRecord(value))
            .slice(0, 4)
            .map((signal) => ({
              source: typeof signal.source === "string" ? signal.source : null,
              type: typeof signal.type === "string" ? signal.type : null,
              reason: typeof signal.reason === "string" ? signal.reason : null,
            }))
          : [],
      },
      fingerprint: {
        inferredOs: typeof fingerprint.inferredOs === "string" ? fingerprint.inferredOs : null,
        inferredProduct: typeof fingerprint.inferredProduct === "string" ? fingerprint.inferredProduct : null,
      },
      recentHints: {
        dhcpHostnames: Array.from(dhcpHostnames).slice(0, 4),
        dnsNames: Array.from(dnsNames).slice(0, 4),
        httpHosts: Array.from(httpHosts).slice(0, 4),
        tlsSni: Array.from(tlsSni).slice(0, 4),
        faviconHashes: Array.from(faviconHashes).map((value) => value.slice(0, 16)).slice(0, 3),
        protocolHints: Array.from(protocolHints).slice(0, 4),
        browserTitles: Array.isArray(browserObservation.endpoints)
          ? browserObservation.endpoints
            .filter((value): value is Record<string, unknown> => isRecord(value))
            .map((endpoint) => typeof endpoint.title === "string" ? endpoint.title : "")
            .filter((value) => value.length > 0)
            .slice(0, 3)
          : [],
      },
      recentObservations: observations.map((observation) => summarizeObservation(observation)),
    },
    routerCandidates,
  };
}

export async function buildOnboardingSystemPrompt(device: Device): Promise<string> {
  const notesRecord = typeof device.metadata.notes === "object" && device.metadata.notes !== null
    ? (device.metadata.notes as Record<string, unknown>)
    : {};
  const operatorNotes =
    typeof notesRecord.operatorContext === "string"
    ? notesRecord.operatorContext as string
    : "";
  const structuredContext =
    typeof notesRecord.structuredContext === "object" && notesRecord.structuredContext !== null
      ? JSON.stringify(notesRecord.structuredContext)
      : "";
  const localContext = await buildOnboardingLocalContext(device);
  const run = stateStore.getLatestAdoptionRun(device.id);
  const accessMethods = stateStore.getAccessMethods(device.id).map((method) => ({
    key: method.key,
    kind: method.kind,
    title: method.title,
    status: method.status,
    selected: method.selected,
    secure: method.secure,
  }));
  const profiles = stateStore.getDeviceProfiles(device.id).map((profile) => ({
    profileId: profile.profileId,
    name: profile.name,
    kind: profile.kind,
    confidence: profile.confidence,
    status: profile.status,
    summary: profile.summary,
    requiredAccessMethods: profile.requiredAccessMethods,
    requiredCredentialProtocols: profile.requiredCredentialProtocols,
  }));
  const draft = isRecord(run?.profileJson.onboardingDraft)
    ? run?.profileJson.onboardingDraft
    : {};
  const credentials = stateStore.getDeviceCredentials(device.id).map((credential) => ({
    protocol: credential.protocol,
    status: credential.status,
    accountLabel: credential.accountLabel ?? null,
    lastValidatedAt: credential.lastValidatedAt ?? null,
  }));

  return [
    "You are Steward's onboarding specialist.",
    "Goal: complete world-class device onboarding through conversation + targeted tool exploration.",
    "You must be practical, precise, and evidence-driven.",
    "Device-scoped persistent widgets are available for this device when the user explicitly asks for a remote, dashboard, panel, or control surface.",
    "Do not create or revise a widget during onboarding unless the user explicitly asks for widget work.",
    "If a widget would help, suggest it in prose instead of creating it automatically.",
    "When the user asks about widgets and a relevant one already exists, prefer the existing widget over creating a duplicate.",
    "Workflow requirements:",
    "1) Determine what this endpoint is responsible for.",
    "2) Request missing credentials only when needed, with explicit reason and least-privilege first.",
    "3) Use available tool skills to inspect services/processes/runtime if access is available.",
    "3b) For deep diagnostics, use steward_shell_read with targeted commands (port owners, process tree, systemd units, runtime fingerprints).",
    "3c) For unknown or HTTP-only devices, run steward_deep_probe before asking the user to identify the device manually.",
    "3d) For GUI-only authentication and navigation, use steward_browser_browse (Playwright) as a first-class tool.",
    "3da) Before public web research or asking the user to identify a private-network device manually, inspect Steward's stored local identity evidence with steward_device_identity.",
    "3e) For vendor docs, current advisories, CVEs, or other external/public facts, use steward_web_research instead of guessing.",
    "3f) Treat public web research as supporting context only. Do not identify a private device solely from vendor/OUI plus common port numbers.",
    "3g) RDP alone does not imply WinRM. Only treat WinRM as available when 5985/5986 or a verified WinRM endpoint is present.",
    "3h) As soon as evidence is strong enough to identify the device class, immediately update its device type and canonical name during onboarding. Do not overwrite names manually set by the user.",
    "3i) If discovery already has a hostname or other identity hint, use it before attempting remote commands just to ask for the hostname.",
    "3j) If the target is still ambiguous and router/gateway candidates are available, call steward_router_lease_snapshot or steward_router_client_drift on those router devices to search for the target IP/MAC before asking the user to check their app/router UI.",
    "4) Produce workload and assurance recommendations with rationale and monitoring approach.",
    "5) Onboarding can wander, but it must eventually complete through the first-party tool steward_complete_onboarding.",
    "6) Call steward_complete_onboarding once you have a credible management profile, accepted access methods, and the workloads and assurances Steward should own.",
    "7) Never output fake <tool_call> blocks.",
    "8) Do not say widgets or remotes are outside Steward's scope when the user asks for them.",
    "9) If local evidence is ambiguous or conflicts with public research, state the leading hypotheses with confidence and ask for confirmation instead of asserting a product family.",
    "When uncertain, ask focused follow-ups and continue exploration.",
    "Prefer concrete operational wording over generic advice.",
    "",
    `Target device id: ${device.id}`,
    `Target device: ${device.name} (${device.ip})`,
    `Discovered hostname: ${device.hostname || "unknown"}`,
    `MAC address: ${device.mac || "unknown"}`,
    `Device type: ${device.type}; OS hint: ${device.os || "unknown"}; vendor: ${device.vendor || "unknown"}`,
    `Observed protocols: ${device.protocols.join(", ") || "none"}`,
    `Observed services: ${device.services.map((service) => `${service.name}:${service.port}`).join(", ") || "none"}`,
    `Stored credentials: ${JSON.stringify(credentials)}`,
    `Observed access methods: ${JSON.stringify(accessMethods)}`,
    `Profile candidates: ${JSON.stringify(profiles)}`,
    `Current onboarding draft: ${JSON.stringify(draft)}`,
    `Stored identity context: ${JSON.stringify(localContext.identity)}`,
    `Router/gateway candidates for lease correlation: ${localContext.routerCandidates.length > 0 ? JSON.stringify(localContext.routerCandidates) : "[]"}`,
    operatorNotes.trim().length > 0 ? `Operator notes: ${operatorNotes}` : "",
    structuredContext.trim().length > 0 ? `Structured memory: ${structuredContext}` : "",
  ].join("\n");
}

export async function synthesizeOnboardingModel(device: Device, sessionId: string): Promise<OnboardingSynthesis> {
  const messages = stateStore.getChatMessages(sessionId)
    .filter((message) => !message.error)
    .slice(-60);

  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

  const provider = await getDefaultProvider();
  const model = await buildLanguageModel(provider);

  const result = await generateText({
    model,
    temperature: 0,
    maxOutputTokens: 1400,
    prompt: [
      "Return ONLY a JSON object with keys:",
      "summary (string), responsibilities (string[]), credentialRequests (array), assurances (array), nextActions (string[]).",
      "credentialRequests item shape: { protocol, reason, priority }",
      "assurances item shape: { id, displayName, assuranceKey, criticality, checkIntervalSec, requiredProtocols, monitorType, rationale }",
      "Rules:",
      "- Assurance proposals must be concrete and tied to observed evidence from transcript.",
      "- Avoid duplicates by assuranceKey.",
      "- Keep assurance count between 1 and 12.",
      "",
      `Device: ${device.name} (${device.ip}) type=${device.type} os=${device.os || "unknown"}`,
      `Protocols: ${device.protocols.join(", ") || "none"}`,
      "Conversation transcript:",
      transcript || "(empty)",
    ].join("\n"),
  });

  const parsed = extractJsonObject(result.text);
  if (!parsed) {
    return {
      summary: "Onboarding synthesis is pending; continue conversation and rerun proposal generation.",
      responsibilities: [],
      credentialRequests: [],
      assurances: [],
      contracts: [],
      nextActions: ["Continue onboarding conversation", "Validate credentials", "Regenerate assurance recommendations"],
    };
  }

  const assurancesRaw = Array.isArray(parsed.assurances)
    ? parsed.assurances
    : Array.isArray(parsed.contracts)
      ? parsed.contracts
      : [];
  const dedupe = new Set<string>();
  const assurances: OnboardingAssuranceProposal[] = [];
  for (let idx = 0; idx < assurancesRaw.length; idx++) {
    const entry = assurancesRaw[idx];
    if (!isRecord(entry)) continue;
    const normalized = normalizeProposal(entry, idx);
    if (!normalized) continue;
    if (dedupe.has(normalized.assuranceKey)) continue;
    dedupe.add(normalized.assuranceKey);
    assurances.push(normalized);
    if (assurances.length >= 12) break;
  }

  const credentialRequestsRaw = Array.isArray(parsed.credentialRequests) ? parsed.credentialRequests : [];
  const credentialRequests = credentialRequestsRaw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const protocol = typeof entry.protocol === "string" ? entry.protocol.trim().toLowerCase() : "";
      if (!protocol) return null;
      const reason = typeof entry.reason === "string" && entry.reason.trim().length > 0
        ? entry.reason.trim()
        : `Credential required for ${protocol}`;
      const priority = entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium";
      return { protocol, reason, priority };
    })
    .filter((entry): entry is { protocol: string; reason: string; priority: "high" | "medium" | "low" } => Boolean(entry))
    .slice(0, 8);

  const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0
    ? parsed.summary.trim()
    : "Onboarding synthesis generated.";

  return {
    summary,
    responsibilities: toStringArray(parsed.responsibilities, 12),
    credentialRequests,
    assurances,
    contracts: assurances,
    nextActions: toStringArray(parsed.nextActions, 12),
  };
}

export const synthesizeOnboardingContracts = synthesizeOnboardingModel;

export function messagesForConversation(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter((message) => !message.error && message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }));
}
