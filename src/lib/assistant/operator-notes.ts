import { generateObject } from "ai";
import { z } from "zod";
import { getDeviceIdentityDescription, looksLikeScannedDeviceName } from "@/lib/devices/identity";
import { buildLanguageModel } from "@/lib/llm/providers";
import { stateStore } from "@/lib/state/store";
import { DEVICE_TYPE_VALUES, type ChatToolEvent, type Device, type DeviceType, type LLMProvider } from "@/lib/state/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

const operatorNotesUpdateSchema = z.object({
  shouldUpdate: z.boolean().optional(),
  operatorNotes: z.string().optional(),
  structuredContext: z.record(z.string(), z.unknown()).optional(),
  identity: z.object({
    shouldRename: z.boolean().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    type: z.string().optional(),
  }).optional(),
  reason: z.string().optional(),
});

function summarizeServiceSurface(device: Device): string {
  const topServices = device.services
    .slice(0, 6)
    .map((service) => `${service.name || service.transport}/${service.port}`);
  return topServices.length > 0 ? topServices.join(", ") : "no confirmed services yet";
}

function buildFallbackOperatorNotes(device: Device, toolEvents: Array<Record<string, unknown>>): string {
  const role = typeof device.role === "string" && device.role.trim().length > 0
    ? device.role.trim()
    : "unspecified role";
  const typeLabel = device.type === "unknown" ? "unknown type" : device.type;
  const base = `${device.name} (${device.ip}) is a ${typeLabel} with ${role}. Surface: ${summarizeServiceSurface(device)}.`;
  const latestToolSummary = toolEvents
    .map((event) => (typeof event.summary === "string" ? event.summary.trim() : ""))
    .find((summary) => summary.length > 0);
  if (!latestToolSummary) {
    return clampText(base, 1200);
  }
  return clampText(`${base} Latest evidence: ${latestToolSummary}.`, 1200);
}

function buildFallbackStructuredContext(device: Device, toolEvents: Array<Record<string, unknown>>): Record<string, unknown> {
  const successfulToolSignals = toolEvents
    .filter((event) => event.status === "completed")
    .map((event) => ({
      label: typeof event.label === "string" ? event.label : "tool",
      summary: typeof event.summary === "string" ? event.summary : "",
    }))
    .filter((event) => event.summary.trim().length > 0)
    .slice(0, 6);

  return {
    observed: {
      name: device.name,
      ip: device.ip,
      type: device.type,
      vendor: device.vendor ?? null,
      os: device.os ?? null,
      role: device.role ?? null,
      protocols: device.protocols.slice(0, 12),
      services: device.services.slice(0, 12).map((service) => ({
        name: service.name,
        transport: service.transport,
        port: service.port,
        product: service.product ?? null,
        version: service.version ?? null,
      })),
    },
    recentToolSignals: successfulToolSignals,
  };
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
  return DEVICE_TYPE_VALUES.includes(normalized) ? normalized : undefined;
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
    const identityRecord = currentIdentityRecord(latestDevice);
    const manualNameLocked = identityRecord.nameManuallySet === true;
    const languageModel = await buildLanguageModel(args.provider, args.model);
    const fallbackNotes = buildFallbackOperatorNotes(latestDevice, toolEvidence);
    const fallbackStructuredContext = buildFallbackStructuredContext(latestDevice, toolEvidence);

    let generated: z.infer<typeof operatorNotesUpdateSchema> | null = null;
    try {
      const result = await generateObject({
        model: languageModel,
        temperature: 0,
        maxOutputTokens: 700,
        schema: operatorNotesUpdateSchema,
        schemaName: "operator_notes_update",
        schemaDescription: "Durable operator note and structured memory updates for a managed device.",
        prompt: [
          "You maintain concise durable operator notes and identity metadata for a managed device.",
          "Rules:",
          "- Update notes when stable operational facts were learned.",
          "- Keep operatorNotes under 1200 chars and focused on durable facts: role, dependencies, auth surface, ports, caveats, consumers, update posture.",
          "- structuredContext should contain durable machine-readable facts only.",
          "- If onboarding is active and the current name looks autogenerated, you may rename the device to a concise operator-friendly name.",
          "- Never rename a device whose current name already looks intentional.",
          "- identity.description must be 1-2 sentences, plain language, and under 280 chars.",
          "- Exclude temporary noise, speculation, and transient probe errors.",
          "",
          `Onboarding session: ${args.onboarding ? "yes" : "no"}`,
          `Current autogenerated-looking name: ${autogeneratedName ? "yes" : "no"}`,
          `Name manually set by user: ${manualNameLocked ? "yes" : "no"}`,
          `Current notes: ${currentNotes || "(empty)"}`,
          `Current description: ${currentDescription || "(empty)"}`,
          `Latest user message: ${args.userInput}`,
          `Latest assistant response: ${args.assistantOutput}`,
          `Recent conversation: ${conversationSlice || "(none)"}`,
          `Device snapshot: ${JSON.stringify(deviceSnapshot)}`,
          `Latest tool evidence: ${toolEvidence.length > 0 ? JSON.stringify(toolEvidence) : "(none)"}`,
          `Fallback operator notes baseline: ${fallbackNotes}`,
          `Fallback structured context baseline: ${JSON.stringify(fallbackStructuredContext)}`,
        ].join("\n"),
      });
      generated = result.object;
    } catch {
      generated = null;
    }

    const shouldUpdate = generated?.shouldUpdate === true;
    const generatedNotes = typeof generated?.operatorNotes === "string"
      ? generated.operatorNotes.trim()
      : "";
    const nextNotes = generatedNotes.length > 0
      ? generatedNotes
      : (currentNotes.length === 0 || toolEvidence.length > 0 ? fallbackNotes : "");
    const generatedStructuredContext = generated?.structuredContext;
    const nextStructuredContext = generatedStructuredContext && isRecord(generatedStructuredContext)
      ? generatedStructuredContext
      : (Object.keys(currentStructuredContext).length === 0 || toolEvidence.length > 0
        ? fallbackStructuredContext
        : undefined);
    const identity = isRecord(generated?.identity) ? generated.identity : {};
    const renameRequested = args.onboarding && autogeneratedName
      && !manualNameLocked
      && (
        identity.shouldRename === true
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
         reason: typeof generated?.reason === "string" ? generated.reason : undefined,
       },
     });
  } catch {
    // best-effort background note maintenance
  }
}
