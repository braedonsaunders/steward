import { generateText } from "ai";
import { getDefaultProvider } from "@/lib/llm/config";
import { buildLanguageModel } from "@/lib/llm/providers";
import { llmHealthController } from "@/lib/llm/health";
import { applyPromptFirewall } from "@/lib/llm/prompt-firewall";
import { stateStore } from "@/lib/state/store";
import type { Device } from "@/lib/state/types";

interface DeviceAdvice {
  deviceId: string;
  role?: string;
  shouldManage: boolean;
  confidence: number;
  requiredCredentials: string[];
  reason: string;
}

const extractJsonArray = (value: string): unknown[] | undefined => {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  const match = value.match(/\[[\s\S]*\]/);
  if (!match) return undefined;

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toAdvice = (item: unknown): DeviceAdvice | undefined => {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const deviceId = typeof record.deviceId === "string" ? record.deviceId : undefined;
  const reason = typeof record.reason === "string" ? record.reason : undefined;
  const shouldManage = typeof record.shouldManage === "boolean" ? record.shouldManage : undefined;
  const confidence = Number(record.confidence);

  if (!deviceId || !reason || shouldManage === undefined || !Number.isFinite(confidence)) {
    return undefined;
  }

  return {
    deviceId,
    role: typeof record.role === "string" ? record.role : undefined,
    shouldManage,
    confidence: Math.max(0, Math.min(1, confidence)),
    requiredCredentials: Array.isArray(record.requiredCredentials)
      ? record.requiredCredentials.filter((value): value is string => typeof value === "string")
      : [],
    reason,
  };
};

export const generateDiscoveryAdvice = async (devices: Device[]): Promise<DeviceAdvice[]> => {
  if (devices.length === 0) {
    return [];
  }

  const runtime = stateStore.getRuntimeSettings();
  if (!runtime.laneBEnabled) {
    return [];
  }

  let providerForHealth = "default";

  try {
    const provider = await getDefaultProvider();
    providerForHealth = provider;
    if (!llmHealthController.laneBAllowed(provider)) {
      return [];
    }

    const model = await buildLanguageModel(provider);

    const compactDevices = devices.map((device) => ({
      deviceId: device.id,
      name: device.name,
      ip: device.ip,
      type: device.type,
      os: device.os,
      protocols: device.protocols,
      services: device.services.map((service) => ({
        port: service.port,
        transport: service.transport,
        name: service.name,
      })),
    }));

    const rawTelemetry = JSON.stringify(compactDevices);
    const firewall = applyPromptFirewall(rawTelemetry);

    const result = await generateText({
      model,
      temperature: 0,
      maxOutputTokens: 800,
      prompt: [
        "You are classifying network devices for onboarding.",
        "For each device, decide whether Steward should actively manage it.",
        "Return ONLY a JSON array. Each object must contain:",
        "deviceId (string), shouldManage (boolean), confidence (0..1 number),",
        "reason (short string), role (optional string), requiredCredentials (array of strings).",
        "requiredCredentials should reference protocols like ssh, winrm, snmp, api, web-admin.",
        "If confidence is below 0.5, set shouldManage=false.",
        firewall.tainted
          ? `Telemetry was sanitized by prompt firewall. Reasons: ${firewall.reasons.join(", ")}`
          : "Telemetry passed prompt firewall.",
        "Devices:",
        firewall.sanitized,
      ].join("\n"),
    });

    llmHealthController.reportSuccess(provider);

    const parsed = extractJsonArray(result.text);
    if (!parsed) {
      return [];
    }

    return parsed.map(toAdvice).filter((item): item is DeviceAdvice => Boolean(item));
  } catch (error) {
    void error;
    llmHealthController.reportFailure(providerForHealth);
    return [];
  }
};
