import { generateText } from "ai";
import { getDeviceIdentityDescription, looksLikeScannedDeviceName } from "@/lib/devices/identity";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import type { ChatToolEvent, Device, DeviceType, LLMProvider } from "@/lib/state/types";

const DEVICE_TYPES: DeviceType[] = [
  "server",
  "workstation",
  "router",
  "firewall",
  "switch",
  "access-point",
  "camera",
  "nas",
  "printer",
  "iot",
  "container-host",
  "hypervisor",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeInlineText(value: string, maxChars: number): string {
  return clampText(value.replace(/\s+/g, " ").trim(), maxChars);
}

function currentNotesRecord(device: Device): Record<string, unknown> {
  return isRecord(device.metadata.notes) ? device.metadata.notes : {};
}

function currentIdentityRecord(device: Device): Record<string, unknown> {
  return isRecord(device.metadata.identity) ? device.metadata.identity : {};
}

function getCurrentOperatorNotes(device: Device): string {
  const notes = currentNotesRecord(device);
  return typeof notes.operatorContext === "string" ? notes.operatorContext.trim() : "";
}

function getCurrentStructuredContext(device: Device): Record<string, unknown> {
  const notes = currentNotesRecord(device);
  return isRecord(notes.structuredContext) ? notes.structuredContext : {};
}

function buildDeviceSnapshot(device: Device): Record<string, unknown> {
  const fingerprint = isRecord(device.metadata.fingerprint) ? device.metadata.fingerprint : {};
  const browser = isRecord(device.metadata.browserObservation) ? device.metadata.browserObservation : {};
  const deepProbe = isRecord(device.metadata.deepProbe) ? device.metadata.deepProbe : {};

  return {
    name: device.name,
    ip: device.ip,
    type: device.type,
    vendor: device.vendor ?? null,
    os: device.os ?? null,
    role: device.role ?? null,
    protocols: device.protocols.slice(0, 10),
    services: device.services.slice(0, 12).map((service) => ({
      port: service.port,
      transport: service.transport,
      name: service.name,
      product: service.product ?? null,
      version: service.version ?? null,
      secure: service.secure,
      httpTitle: service.httpInfo?.title ?? null,
      redirectsTo: service.httpInfo?.redirectsTo ?? null,
      serverHeader: service.httpInfo?.serverHeader ?? null,
    })),
    fingerprint: {
      inferredOs: typeof fingerprint.inferredOs === "string" ? fingerprint.inferredOs : null,
      inferredProduct: typeof fingerprint.inferredProduct === "string" ? fingerprint.inferredProduct : null,
      sshBanner: typeof fingerprint.sshBanner === "string" ? fingerprint.sshBanner : null,
      mqtt: isRecord(fingerprint.mqtt) ? fingerprint.mqtt : null,
    },
    browser: {
      endpoints: Array.isArray(browser.endpoints)
        ? browser.endpoints
          .map((endpoint) => isRecord(endpoint) ? endpoint : null)
          .filter((endpoint): endpoint is Record<string, unknown> => Boolean(endpoint))
          .slice(0, 4)
        : [],
    },
    deepProbeSummary: isRecord(deepProbe.summary) ? deepProbe.summary : null,
  };
}

function buildToolEventDigest(toolEvents: ChatToolEvent[] | undefined): Array<Record<string, unknown>> {
  return (toolEvents ?? [])
    .slice(-8)
    .map((event) => ({
      label: event.label,
      kind: event.kind,
      status: event.status,
      summary: event.summary ?? event.error ?? null,
      inputPreview: event.inputPreview ? normalizeInlineText(event.inputPreview, 240) : null,
      outputPreview: event.outputPreview ? clampText(event.outputPreview, 420) : null,
    }));
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim().replace(/[\u0000-\u001f]+/g, "");
  if (normalized.length < 2) {
    return "";
  }
  return normalized.slice(0, 96);
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  return clampText(normalized, 280);
}

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  return normalized.slice(0, 96);
}

function normalizeType(value: unknown): DeviceType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim() as DeviceType;
  return DEVICE_TYPES.includes(normalized) ? normalized : undefined;
}

export async function maybeUpdateOperatorNotes(args: {
  device: Device;
  provider: LLMProvider;
  model?: string;
  userInput: string;
  assistantOutput: string;
  sessionId?: string;
  onboarding: boolean;
  toolEvents?: ChatToolEvent[];
}): Promise<void> {
  try {
    const latestDevice = stateStore.getDeviceById(args.device.id);
    if (!latestDevice) {
      return;
    }

    const currentNotes = getCurrentOperatorNotes(latestDevice);
    const currentStructuredContext = getCurrentStructuredContext(latestDevice);
    const currentDescription = getDeviceIdentityDescription(latestDevice);
    const conversationSlice = args.sessionId
      ? stateStore
        .getChatMessages(args.sessionId)
        .slice(-10)
        .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
        .join("\n\n")
      : "";

    const deviceSnapshot = buildDeviceSnapshot(latestDevice);
    const toolEvidence = buildToolEventDigest(args.toolEvents);
    const autogeneratedName = looksLikeScannedDeviceName(latestDevice);
    const languageModel = await buildLanguageModel(args.provider, args.model);
    const result = await generateText({
      model: languageModel,
      temperature: 0,
      maxOutputTokens: 700,
      prompt: [
        "You maintain concise durable operator notes and identity metadata for a managed device.",
        "Return JSON only:",
        '{"shouldUpdate": boolean, "operatorNotes": string, "structuredContext": object, "identity": {"shouldRename": boolean, "name": string, "description": string, "role": string, "type": string}, "reason": string}',
        "Rules:",
        "- Update notes only when stable operational facts were learned.",
        "- Keep operatorNotes under 1200 chars and focused on durable facts: role, dependencies, auth surface, ports, caveats, consumers, update posture.",
        "- structuredContext should contain durable machine-readable facts only.",
        "- If onboarding is active and the current name looks autogenerated, you may rename the device to a concise operator-friendly name.",
        "- Never rename a device whose current name already looks intentional.",
        "- identity.description must be 1-2 sentences, plain language, and under 280 chars.",
        "- Exclude temporary noise, speculation, and transient probe errors.",
        "",
        `Onboarding session: ${args.onboarding ? "yes" : "no"}`,
        `Current autogenerated-looking name: ${autogeneratedName ? "yes" : "no"}`,
        `Current notes: ${currentNotes || "(empty)"}`,
        `Current description: ${currentDescription || "(empty)"}`,
        `Latest user message: ${args.userInput}`,
        `Latest assistant response: ${args.assistantOutput}`,
        `Recent conversation: ${conversationSlice || "(none)"}`,
        `Device snapshot: ${JSON.stringify(deviceSnapshot)}`,
        `Latest tool evidence: ${toolEvidence.length > 0 ? JSON.stringify(toolEvidence) : "(none)"}`,
      ].join("\n"),
    });

    const parsed = extractJsonObject(result.text);
    if (!parsed) {
      return;
    }

    const shouldUpdate = parsed.shouldUpdate === true;
    const nextNotes = typeof parsed.operatorNotes === "string"
      ? parsed.operatorNotes.trim()
      : (typeof parsed.notes === "string" ? parsed.notes.trim() : "");
    const nextStructuredContext = isRecord(parsed.structuredContext)
      ? parsed.structuredContext
      : undefined;
    const identity = isRecord(parsed.identity) ? parsed.identity : {};
    const renameRequested = args.onboarding && autogeneratedName
      && (
        identity.shouldRename === true
        || identity.rename === true
        || (typeof identity.name === "string" && identity.name.trim().length > 0)
      );
    const nextName = renameRequested ? normalizeName(identity.name) : "";
    const nextDescription = args.onboarding ? normalizeDescription(identity.description) : "";
    const nextRole = args.onboarding ? normalizeRole(identity.role) : "";
    const nextType = args.onboarding ? normalizeType(identity.type) : undefined;
    const structuredChanged = nextStructuredContext
      ? JSON.stringify(nextStructuredContext) !== JSON.stringify(currentStructuredContext)
      : false;

    const changedFields: string[] = [];
    const now = new Date().toISOString();
    const notesRecord = currentNotesRecord(latestDevice);
    const identityRecord = currentIdentityRecord(latestDevice);

    const updatedDevice: Device = {
      ...latestDevice,
      metadata: {
        ...latestDevice.metadata,
      },
      lastChangedAt: latestDevice.lastChangedAt,
    };

    if (nextNotes.length > 0 && nextNotes !== currentNotes) {
      updatedDevice.metadata.notes = {
        ...notesRecord,
        operatorContext: nextNotes,
        operatorContextUpdatedAt: now,
      };
      changedFields.push("operatorNotes");
    }

    if (nextStructuredContext && structuredChanged) {
      updatedDevice.metadata.notes = {
        ...(isRecord(updatedDevice.metadata.notes) ? updatedDevice.metadata.notes : notesRecord),
        structuredContext: nextStructuredContext,
        structuredContextUpdatedAt: now,
      };
      changedFields.push("structuredContext");
    }

    if (nextDescription.length > 0 && nextDescription !== currentDescription) {
      updatedDevice.metadata.identity = {
        ...identityRecord,
        description: nextDescription,
        descriptionUpdatedAt: now,
        source: args.onboarding ? "onboarding_chat" : "chat",
      };
      changedFields.push("description");
    }

    if (nextRole.length > 0 && nextRole !== latestDevice.role) {
      updatedDevice.role = nextRole;
      changedFields.push("role");
    }

    if (nextType && nextType !== latestDevice.type) {
      updatedDevice.type = nextType;
      changedFields.push("type");
    }

    if (nextName.length > 0 && nextName !== latestDevice.name) {
      updatedDevice.name = nextName;
      changedFields.push("name");
    }

    if ((!shouldUpdate && changedFields.length === 0) || changedFields.length === 0) {
      return;
    }

    updatedDevice.lastChangedAt = now;
    await stateStore.upsertDevice(updatedDevice);

    if (args.onboarding && args.sessionId && updatedDevice.name !== latestDevice.name) {
      const session = stateStore.getChatSessionById(args.sessionId);
      if (session?.deviceId === latestDevice.id) {
        stateStore.updateChatSessionTitle(args.sessionId, `[Onboarding] ${updatedDevice.name}`);
      }
    }

    await stateStore.addAction({
      actor: "steward",
      kind: "learn",
      message: `Updated learned device context for ${updatedDevice.name}`,
      context: {
        deviceId: updatedDevice.id,
        sessionId: args.sessionId ?? null,
        onboarding: args.onboarding,
        changedFields,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      },
    });
  } catch {
    // best-effort background note maintenance
  }
}
