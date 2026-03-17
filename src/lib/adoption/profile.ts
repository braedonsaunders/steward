import { generateText } from "ai";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { llmHealthController } from "@/lib/llm/health";
import { applyPromptFirewall } from "@/lib/llm/prompt-firewall";
import { isWindowsPlatformDevice } from "@/lib/protocols/catalog";
import type { AdoptionQuestionOption, Device } from "@/lib/state/types";

export interface DeviceCredentialIntent {
  protocol: string;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface AdapterCandidateHint {
  adapterId: string;
  protocol: string;
  score: number;
  reason: string;
}

export interface OnboardingQuestionDraft {
  questionKey: string;
  prompt: string;
  options: AdoptionQuestionOption[];
  required: boolean;
}

export interface WorkloadDraft {
  workloadKey: string;
  displayName: string;
  reason: string;
  criticality: "low" | "medium" | "high";
}

export type ServiceContractDraft = WorkloadDraft;

export interface DeviceAdoptionProfile {
  summary: string;
  role?: string;
  confidence: number;
  workloads: WorkloadDraft[];
  watchItems: string[];
  credentialIntents: DeviceCredentialIntent[];
  adapterCandidates: AdapterCandidateHint[];
  questions: OnboardingQuestionDraft[];
}

const SUPPORTED_CREDENTIAL_PROTOCOLS = new Set([
  "ssh",
  "telnet",
  "winrm",
  "snmp",
  "http-api",
  "docker",
  "kubernetes",
  "mqtt",
  "rtsp",
  "printing",
]);

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toQuestionOptions(value: unknown): AdoptionQuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const optionValue = typeof record.value === "string" ? record.value.trim() : "";
      if (!label || !optionValue) return undefined;
      return { label, value: optionValue };
    })
    .filter((item): item is AdoptionQuestionOption => Boolean(item))
    .slice(0, 8);
}

function toCredentialIntents(value: unknown): DeviceCredentialIntent[] {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const protocolRaw = typeof record.protocol === "string" ? record.protocol.trim().toLowerCase() : "";
        if (!SUPPORTED_CREDENTIAL_PROTOCOLS.has(protocolRaw)) return undefined;
        const reason = typeof record.reason === "string" ? record.reason : `Required for ${protocolRaw} management`;
        const priority = record.priority === "high" || record.priority === "low" ? record.priority : "medium";
        return { protocol: protocolRaw, reason, priority } as DeviceCredentialIntent;
      })
      .filter((item): item is DeviceCredentialIntent => Boolean(item)),
    (item) => item.protocol,
  );
}

function toAdapterCandidates(value: unknown): AdapterCandidateHint[] {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const adapterId = typeof record.adapterId === "string" ? record.adapterId.trim() : "";
        const protocol = typeof record.protocol === "string" ? record.protocol.trim().toLowerCase() : "";
        if (!adapterId || !protocol) return undefined;
        const scoreRaw = Number(record.score);
        const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(1, scoreRaw)) : 0.5;
        const reason = typeof record.reason === "string" ? record.reason : "Potential adapter fit";
        return { adapterId, protocol, score, reason } as AdapterCandidateHint;
      })
      .filter((item): item is AdapterCandidateHint => Boolean(item)),
    (item) => `${item.adapterId}:${item.protocol}`,
  );
}

function toWorkloads(value: unknown): WorkloadDraft[] {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
        if (!displayName) return undefined;
        const workloadKey = typeof record.workloadKey === "string" && record.workloadKey.trim().length > 0
          ? record.workloadKey.trim()
          : typeof record.serviceKey === "string" && record.serviceKey.trim().length > 0
            ? record.serviceKey.trim()
          : displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const reason = typeof record.reason === "string" ? record.reason : "Identified as a critical responsibility";
        const criticality = record.criticality === "high" || record.criticality === "low"
          ? record.criticality
          : "medium";
        return { workloadKey, displayName, reason, criticality } as WorkloadDraft;
      })
      .filter((item): item is WorkloadDraft => Boolean(item)),
    (item) => item.workloadKey,
  );
}

function toQuestions(value: unknown): OnboardingQuestionDraft[] {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const questionKey = typeof record.questionKey === "string" ? record.questionKey.trim() : "";
        const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
        if (!questionKey || !prompt) return undefined;
        const options = toQuestionOptions(record.options);
        return {
          questionKey,
          prompt,
          options,
          required: record.required !== false,
        } as OnboardingQuestionDraft;
      })
      .filter((item): item is OnboardingQuestionDraft => Boolean(item)),
    (item) => item.questionKey,
  ).slice(0, 8);
}

function fallbackProfile(device: Device): DeviceAdoptionProfile {
  const credentialIntents: DeviceCredentialIntent[] = [];
  const adoptionRecord = device.metadata.adoption as Record<string, unknown> | undefined;
  const existingAssuranceCountRaw = Number(
    adoptionRecord?.assuranceCount ?? adoptionRecord?.serviceContractCount ?? 0,
  );
  const existingAssuranceCount = Number.isFinite(existingAssuranceCountRaw)
    ? Math.max(0, Math.floor(existingAssuranceCountRaw))
    : 0;
  const askQuestionForWorkloads = device.services.length > 0 && existingAssuranceCount === 0;

  if (device.protocols.includes("ssh")) {
    credentialIntents.push({ protocol: "ssh", reason: "Remote shell management and diagnostics", priority: "high" });
  }
  if (device.protocols.includes("winrm")) {
    credentialIntents.push({ protocol: "winrm", reason: "Windows service management and diagnostics", priority: "high" });
  }
  if (device.protocols.includes("powershell-ssh")) {
    credentialIntents.push({ protocol: "powershell-ssh", reason: "PowerShell remoting over SSH for Windows automation", priority: "medium" });
  }
  if (device.protocols.includes("wmi")) {
    credentialIntents.push({ protocol: "wmi", reason: "Windows inventory and DCOM/RPC management", priority: "medium" });
  }
  if (device.protocols.includes("smb")) {
    credentialIntents.push({ protocol: "smb", reason: "Windows share access, artifact collection, and file staging", priority: "medium" });
  }
  if (device.protocols.includes("rdp")) {
    credentialIntents.push({ protocol: "rdp", reason: "Interactive Windows remote control and GUI access", priority: "low" });
  }
  if (device.protocols.includes("vnc")) {
    credentialIntents.push({ protocol: "vnc", reason: "Cross-platform remote desktop control and GUI access", priority: "low" });
  }
  if (device.protocols.includes("snmp")) {
    credentialIntents.push({ protocol: "snmp", reason: "Network and device telemetry collection", priority: "medium" });
  }
  if (device.protocols.includes("http-api")) {
    credentialIntents.push({ protocol: "http-api", reason: "API or web management surface access", priority: "medium" });
  }
  if (device.protocols.includes("docker")) {
    credentialIntents.push({ protocol: "docker", reason: "Container lifecycle and health checks", priority: "medium" });
  }
  if (device.protocols.includes("kubernetes")) {
    credentialIntents.push({ protocol: "kubernetes", reason: "Cluster responsibility and node management", priority: "medium" });
  }
  if (device.protocols.includes("mqtt")) {
    credentialIntents.push({ protocol: "mqtt", reason: "Native telemetry subscriptions and command exchange", priority: "medium" });
  }

  const workloads = device.services
    .slice(0, 6)
    .map((service) => ({
      workloadKey: `${service.transport}_${service.port}_${service.name}`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
      displayName: `${service.name}:${service.port}`,
      reason: `Observed endpoint on port ${service.port}; likely maps to a responsibility or dependency.`,
      criticality: service.port === 22 || service.port === 443 || service.port === 3389 ? "high" : "medium",
    })) as WorkloadDraft[];

  const questions: OnboardingQuestionDraft[] = [];
  const isWindowsWorkstation = device.type === "workstation"
    && (isWindowsPlatformDevice(device) || device.protocols.includes("rdp") || device.protocols.includes("winrm"));

  if (askQuestionForWorkloads) {
    const discoveredServicesLabel = device.services
      .slice(0, 8)
      .map((service) => `${service.name}:${service.port}`)
      .join(", ");
    questions.push({
      questionKey: "critical_services_confirm",
      prompt: `List the responsibilities Steward should actively keep healthy on this device (comma-separated). Observed endpoints: ${discoveredServicesLabel || "none"}. Include responsibilities discovery may have missed (for example: nginx reverse proxy, Laravel queue workers, MySQL, backup jobs).`,
      options: [],
      required: true,
    });
  } else if (isWindowsWorkstation) {
    questions.push({
      questionKey: "workstation_role",
      prompt: "What is this workstation primarily used for?",
      options: [
        { label: "Gaming", value: "gaming" },
        { label: "Development", value: "development" },
        { label: "Office / Productivity", value: "office" },
        { label: "Shared / Family", value: "shared" },
      ],
      required: true,
    });
  } else {
    questions.push({
      questionKey: "device_purpose",
      prompt: "What is this device primarily used for?",
      options: [
        { label: "Infrastructure", value: "infrastructure" },
        { label: "Application Host", value: "application_host" },
        { label: "Peripheral / Edge Device", value: "peripheral" },
      ],
      required: true,
    });
  }

  if (credentialIntents.length > 0) {
    questions.push({
      questionKey: "credential_scope",
      prompt: "Should Steward request full admin credentials now, or start with read-only credentials?",
      options: [
        { label: "Read-only first", value: "read_only" },
        { label: "Admin now", value: "admin" },
      ],
      required: false,
    });
  }

  if (isWindowsWorkstation && device.protocols.includes("rdp")) {
    questions.push({
      questionKey: "rdp_exposure_intent",
      prompt: "How should Steward treat Remote Desktop on this workstation?",
      options: [
        { label: "Internal only", value: "internal_only" },
        { label: "Disabled if possible", value: "disable_if_possible" },
        { label: "Needs remote access", value: "needs_remote_access" },
      ],
      required: false,
    });
  }

  questions.push({
    questionKey: "manual_service_contracts",
    prompt: "Any additional responsibilities or assurances to add manually? Provide comma-separated names and optional ports (example: laravel-api:443, queue-worker, nightly-backups).",
    options: [],
    required: false,
  });

  return {
    summary: `Steward onboarded ${device.name} and prepared management intents.`,
    role: device.role,
    confidence: 0.55,
    workloads,
    watchItems: isWindowsWorkstation
      ? ["Availability drift", "Patch hygiene", "Remote desktop exposure", "Disk pressure"]
      : ["Availability drift", "Certificate expiry", "Resource pressure"],
    credentialIntents: dedupeBy(credentialIntents, (item) => item.protocol),
    adapterCandidates: [],
    questions,
  };
}

function parseProfile(raw: Record<string, unknown>, device: Device): DeviceAdoptionProfile {
  const summary = typeof raw.summary === "string" && raw.summary.trim().length > 0
    ? raw.summary.trim()
    : `Onboarding profile generated for ${device.name}.`;
  const role = typeof raw.role === "string" && raw.role.trim().length > 0 ? raw.role.trim() : undefined;
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.6;

  const workloads = toWorkloads(raw.workloads ?? raw.criticalServices);
  const watchItems = Array.isArray(raw.watchItems)
    ? raw.watchItems.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 12)
    : [];
  const credentialIntents = toCredentialIntents(raw.credentialIntents);
  const adapterCandidates = toAdapterCandidates(raw.adapterCandidates);
  const questions = toQuestions(raw.questions);

  return {
    summary,
    role,
    confidence,
    workloads,
    watchItems,
    credentialIntents,
    adapterCandidates,
    questions,
  };
}

export async function generateDeviceAdoptionProfile(
  device: Device,
  context: {
    adapterIds: string[];
    existingAssuranceCount?: number;
  },
): Promise<DeviceAdoptionProfile> {
  let providerForHealth = "default";

  try {
    const provider = await getDefaultProvider();
    providerForHealth = provider;
    const model = await buildLanguageModel(provider);

    const telemetry = JSON.stringify({
      id: device.id,
      name: device.name,
      ip: device.ip,
      type: device.type,
      os: device.os,
      vendor: device.vendor,
      role: device.role,
      status: device.status,
      protocols: device.protocols,
      services: device.services.map((service) => ({
        port: service.port,
        transport: service.transport,
        name: service.name,
        product: service.product,
        version: service.version,
        secure: service.secure,
      })),
      metadata: {
        classification: device.metadata.classification,
        fingerprint: device.metadata.fingerprint,
      },
      availableAdapters: context.adapterIds,
      existingAssuranceCount: context.existingAssuranceCount ?? 0,
    });

    const firewall = applyPromptFirewall(telemetry);

    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 1200,
      prompt: [
        "You are generating an onboarding profile for a network endpoint managed by Steward.",
        "Return ONLY a single JSON object with keys:",
        "summary (string), role (string optional), confidence (0..1),",
    "responsibilities (array of {workloadKey, displayName, reason, criticality}),",
        "watchItems (string array),",
        "credentialIntents (array of {protocol, reason, priority}),",
        "adapterCandidates (array of {adapterId, protocol, score, reason}),",
        "questions (array of {questionKey, prompt, options:[{label,value}], required:boolean}).",
         "Rules:",
         "- Ask questions only when evidence is ambiguous.",
         "- Keep questions under 8 total.",
    "- For questionKey 'critical_services_confirm', do NOT provide options. Ask for a comma-separated free-text list of responsibilities so the user can include things discovery missed.",
         "- If existingAssuranceCount > 0, do not require critical_services_confirm again unless telemetry clearly conflicts.",
         "- RDP-only Windows endpoints are usually workstations, not servers.",
         "- Do not request WinRM credentials unless WinRM is actually observed or explicitly confirmed in telemetry.",
         "- Use only these protocols for credentialIntents: ssh, winrm, powershell-ssh, wmi, smb, rdp, snmp, http-api, docker, kubernetes, mqtt, rtsp, printing.",
         "- Distinguish Windows platform identity from specific access transports. Request only the protocols actually supported or clearly needed.",
        `Known adapter ids: ${context.adapterIds.join(", ") || "none"}`,
        firewall.tainted
          ? `Telemetry was sanitized by prompt firewall. Reasons: ${firewall.reasons.join(", ")}`
          : "Telemetry passed prompt firewall.",
        "Device telemetry:",
        firewall.sanitized,
      ].join("\n"),
    });

    llmHealthController.reportSuccess(provider);

    const parsed = extractJsonObject(result.text);
    if (!parsed) {
      return fallbackProfile(device);
    }

    const profile = parseProfile(parsed, device);
    const normalizedQuestions = profile.questions.map((question) => {
      if (question.questionKey !== "critical_services_confirm") {
        return question;
      }
      return {
        ...question,
        options: [],
      };
    }).filter((question) => {
      if (question.questionKey !== "critical_services_confirm") {
        return true;
      }
      return (context.existingAssuranceCount ?? 0) === 0;
    });

    return {
      ...profile,
      questions: normalizedQuestions,
      credentialIntents: profile.credentialIntents.length > 0
        ? profile.credentialIntents
        : fallbackProfile(device).credentialIntents,
    };
  } catch {
    llmHealthController.reportFailure(providerForHealth);
    return fallbackProfile(device);
  }
}
