import { generateText } from "ai";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { llmHealthController } from "@/lib/llm/health";
import { applyPromptFirewall } from "@/lib/llm/prompt-firewall";
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

export interface ServiceContractDraft {
  serviceKey: string;
  displayName: string;
  reason: string;
  criticality: "low" | "medium" | "high";
}

export interface DeviceAdoptionProfile {
  summary: string;
  role?: string;
  confidence: number;
  criticalServices: ServiceContractDraft[];
  watchItems: string[];
  credentialIntents: DeviceCredentialIntent[];
  adapterCandidates: AdapterCandidateHint[];
  questions: OnboardingQuestionDraft[];
}

const SUPPORTED_PROTOCOLS = new Set([
  "ssh",
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
        if (!SUPPORTED_PROTOCOLS.has(protocolRaw)) return undefined;
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

function toServiceContracts(value: unknown): ServiceContractDraft[] {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => {
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
        if (!displayName) return undefined;
        const serviceKey = typeof record.serviceKey === "string" && record.serviceKey.trim().length > 0
          ? record.serviceKey.trim()
          : displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        const reason = typeof record.reason === "string" ? record.reason : "Identified as critical workload";
        const criticality = record.criticality === "high" || record.criticality === "low"
          ? record.criticality
          : "medium";
        return { serviceKey, displayName, reason, criticality } as ServiceContractDraft;
      })
      .filter((item): item is ServiceContractDraft => Boolean(item)),
    (item) => item.serviceKey,
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
  const existingContractsRaw = Number((device.metadata.adoption as Record<string, unknown> | undefined)?.serviceContractCount ?? 0);
  const existingContracts = Number.isFinite(existingContractsRaw) ? Math.max(0, Math.floor(existingContractsRaw)) : 0;
  const askQuestionForServices = device.services.length > 0 && existingContracts === 0;

  if (device.protocols.includes("ssh")) {
    credentialIntents.push({ protocol: "ssh", reason: "Remote shell management and diagnostics", priority: "high" });
  }
  if (device.protocols.includes("winrm") || device.protocols.includes("windows")) {
    credentialIntents.push({ protocol: "winrm", reason: "Windows service management and diagnostics", priority: "high" });
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
    credentialIntents.push({ protocol: "kubernetes", reason: "Cluster workload and node management", priority: "medium" });
  }

  const criticalServices = device.services
    .slice(0, 6)
    .map((service) => ({
      serviceKey: `${service.transport}_${service.port}_${service.name}`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase(),
      displayName: `${service.name}:${service.port}`,
      reason: `Observed open service on port ${service.port}`,
      criticality: service.port === 22 || service.port === 443 || service.port === 3389 ? "high" : "medium",
    })) as ServiceContractDraft[];

  const questions: OnboardingQuestionDraft[] = [];
  if (askQuestionForServices) {
    const discoveredServicesLabel = device.services
      .slice(0, 8)
      .map((service) => `${service.name}:${service.port}`)
      .join(", ");
    questions.push({
      questionKey: "critical_services_confirm",
      prompt: `List every service Steward must keep running and monitor closely (comma-separated). Discovered: ${discoveredServicesLabel || "none"}. Include any app services that discovery missed (for example: nginx, php-fpm, laravel-worker, mysql).`,
      options: [],
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

  questions.push({
    questionKey: "manual_service_contracts",
    prompt: "Any additional service contracts to add manually? Provide comma-separated service names and optional ports (example: laravel-api:443, queue-worker, scheduler).",
    options: [],
    required: false,
  });

  return {
    summary: `Steward onboarded ${device.name} and prepared management intents.`,
    role: device.role,
    confidence: 0.55,
    criticalServices,
    watchItems: ["Availability drift", "Certificate expiry", "Resource pressure"],
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

  const criticalServices = toServiceContracts(raw.criticalServices);
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
    criticalServices,
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
    existingServiceContractsCount?: number;
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
      existingServiceContractsCount: context.existingServiceContractsCount ?? 0,
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
        "criticalServices (array of {serviceKey, displayName, reason, criticality}),",
        "watchItems (string array),",
        "credentialIntents (array of {protocol, reason, priority}),",
        "adapterCandidates (array of {adapterId, protocol, score, reason}),",
        "questions (array of {questionKey, prompt, options:[{label,value}], required:boolean}).",
         "Rules:",
         "- Ask questions only when evidence is ambiguous.",
         "- Keep questions under 8 total.",
         "- For questionKey 'critical_services_confirm', do NOT provide options. Ask for a comma-separated free-text list so user can include undiscovered services.",
         "- If existingServiceContractsCount > 0, do not require critical_services_confirm again unless telemetry clearly conflicts.",
         "- Use only these protocols: ssh, winrm, snmp, http-api, docker, kubernetes, mqtt, rtsp, printing.",
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
      return (context.existingServiceContractsCount ?? 0) === 0;
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
