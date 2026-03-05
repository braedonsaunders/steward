import { dynamicTool, jsonSchema } from "ai";
import { adapterRegistry } from "@/lib/adapters/registry";
import {
  computeDeviceStateHash,
  executeOperationWithGates,
} from "@/lib/adapters/execution-kernel";
import { evaluatePolicy } from "@/lib/policy/engine";
import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type {
  ActionClass,
  Device,
  OperationKind,
  OperationMode,
  OperationSpec,
} from "@/lib/state/types";

interface ExecuteArgs {
  device_id?: string;
  input?: Record<string, unknown>;
}

interface SkillExecutionConfig {
  kind?: OperationKind;
  mode?: OperationMode;
  adapterId?: string;
  timeoutMs?: number;
  expectedSemanticTarget?: string;
  commandTemplate?: string;
  commandTemplates?: Partial<Record<OperationKind, string>>;
}

interface SkillRuntimeDescriptor {
  adapterId: string;
  adapterName: string;
  skillId: string;
  skillName: string;
  operationKinds: OperationKind[];
  toolCallName: string;
  toolCallDescription: string;
  toolCallParameters: Record<string, unknown>;
  execution: SkillExecutionConfig;
}

const OPERATION_KINDS: OperationKind[] = [
  "shell.command",
  "service.restart",
  "service.stop",
  "container.restart",
  "container.stop",
  "http.request",
  "cert.renew",
  "file.copy",
  "network.config",
];

const MUTATING_KINDS = new Set<OperationKind>([
  "service.restart",
  "service.stop",
  "container.restart",
  "container.stop",
  "cert.renew",
  "file.copy",
  "network.config",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationKind(value: string): value is OperationKind {
  return OPERATION_KINDS.includes(value as OperationKind);
}

function toOperationKind(value: unknown): OperationKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return isOperationKind(normalized) ? normalized : undefined;
}

function shellEscapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

function resolveMode(kind: OperationKind, requested?: unknown): OperationMode {
  if (requested === "read" || requested === "mutate") {
    return requested;
  }
  return MUTATING_KINDS.has(kind) ? "mutate" : "read";
}

async function resolveDeviceByTarget(rawTarget: string | undefined, attachedDeviceId?: string): Promise<Device | null> {
  const target = rawTarget?.trim();
  if ((!target || target.length === 0) && attachedDeviceId) {
    return stateStore.getDeviceById(attachedDeviceId);
  }

  if (!target) {
    return null;
  }

  const byId = stateStore.getDeviceById(target);
  if (byId) return byId;

  const normalized = target.toLowerCase();
  const state = await stateStore.getState();
  return state.devices.find((device) =>
    device.ip.toLowerCase() === normalized || device.name.toLowerCase() === normalized,
  ) ?? null;
}

function validateDeviceReadyForToolUse(
  device: Device,
  options?: { allowPreOnboardingExecution?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const adoptionStatus = getDeviceAdoptionStatus(device);
  if (adoptionStatus !== "adopted") {
    return { ok: false, reason: `Device ${device.name} is not adopted yet.` };
  }

  if (options?.allowPreOnboardingExecution) {
    return { ok: true };
  }

  const run = stateStore.getLatestAdoptionRun(device.id);
  if (!run || run.status !== "completed") {
    return { ok: false, reason: `Device ${device.name} onboarding is not complete yet.` };
  }

  const unresolvedRequired = stateStore
    .getAdoptionQuestions(device.id, { runId: run.id, unresolvedOnly: true })
    .filter((question) => question.required)
    .length;

  if (unresolvedRequired > 0) {
    return {
      ok: false,
      reason: `Device ${device.name} still has ${unresolvedRequired} required onboarding questions pending.`,
    };
  }

  return { ok: true };
}

function hasSelectedBindingForAdapter(deviceId: string, adapterId: string): boolean {
  const bindings = stateStore.getDeviceAdapterBindings(deviceId);
  if (bindings.length === 0) {
    return true;
  }
  return bindings.some((binding) => binding.selected && binding.adapterId === adapterId);
}

function inferAdapterForKind(kind: OperationKind, device: Device): string {
  const protocols = new Set(device.protocols.map((protocol) => protocol.toLowerCase()));

  if (kind === "http.request") return "http-api";
  if (kind === "container.restart" || kind === "container.stop") return "docker";
  if (kind === "service.restart" || kind === "service.stop") {
    if (protocols.has("winrm")) return "winrm";
    if (protocols.has("ssh")) return "ssh";
  }
  if (kind === "shell.command") {
    if (protocols.has("ssh")) return "ssh";
    if (protocols.has("winrm")) return "winrm";
    if (protocols.has("docker")) return "docker";
    if (protocols.has("snmp")) return "snmp";
  }
  if (protocols.has("ssh")) return "ssh";
  if (protocols.has("winrm")) return "winrm";
  if (protocols.has("docker")) return "docker";
  if (protocols.has("http-api") || protocols.has("http")) return "http-api";
  return "ssh";
}

function defaultCommandTemplate(kind: OperationKind, adapterId: string, input: Record<string, unknown>): string | null {
  if (kind === "http.request") {
    const secure = input.secure !== false;
    const port = Number(input.port);
    const safePort = Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : (secure ? 443 : 80);
    const pathRaw = typeof input.path === "string" && input.path.trim().length > 0
      ? input.path.trim()
      : "/";
    const safePath = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
    const timeoutMs = Number(input.timeout_ms);
    const timeoutSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(2, Math.min(30, Math.floor(timeoutMs / 1000)))
      : 8;
    const scheme = secure ? "https" : "http";
    return `curl -sS -k --max-time ${timeoutSeconds} ${scheme}://{{host}}:${safePort}${safePath}`;
  }

  if (kind === "shell.command") {
    const userCommand = typeof input.command === "string" ? input.command.trim() : "";
    if (adapterId === "winrm") {
      const command = userCommand || "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime";
      return `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { ${command} }"`;
    }
    if (adapterId === "docker") {
      const command = userCommand || "ps --format '{{.Names}} {{.Status}} {{.Image}}'";
      return `docker -H tcp://{{host}} ${command}`;
    }
    if (adapterId === "snmp") {
      const command = userCommand || "snmpget -v2c -c public {{host}} SNMPv2-MIB::sysDescr.0 2>/dev/null";
      return command;
    }
    const command = userCommand || "uname -a; uptime; df -h; free -m";
    return `ssh {{host}} '${shellEscapeSingleQuoted(command)}'`;
  }

  if (kind === "service.restart" || kind === "service.stop") {
    const service = typeof input.service === "string" ? input.service.trim() : "";
    if (!service) return null;
    if (adapterId === "winrm") {
      const verb = kind === "service.restart" ? "Restart-Service" : "Stop-Service";
      return `pwsh -NoLogo -NonInteractive -Command "Invoke-Command -ComputerName {{host}} -ScriptBlock { ${verb} -Name '${service}' -ErrorAction Stop }"`;
    }
    const verb = kind === "service.restart" ? "restart" : "stop";
    return `ssh {{host}} 'sudo systemctl ${verb} ${shellEscapeSingleQuoted(service)}'`;
  }

  if (kind === "container.restart" || kind === "container.stop") {
    const container = typeof input.container === "string" ? input.container.trim() : "";
    if (!container) return null;
    const verb = kind === "container.restart" ? "restart" : "stop";
    return `docker -H tcp://{{host}} ${verb} ${container}`;
  }

  return null;
}

function makeOperation(
  kind: OperationKind,
  adapterId: string,
  mode: OperationMode,
  commandTemplate: string,
  expectedSemanticTarget: string,
  timeoutMs: number,
): OperationSpec {
  return {
    id: `tool:${kind}:${Date.now()}`,
    adapterId,
    kind,
    mode,
    timeoutMs,
    commandTemplate,
    expectedSemanticTarget,
    safety: {
      dryRunSupported: false,
      requiresConfirmedRevert: false,
      criticality: mode === "mutate" ? "medium" : "low",
    },
  };
}

function pickOperationKind(descriptor: SkillRuntimeDescriptor, input: Record<string, unknown>): OperationKind {
  const requested = toOperationKind(input.operation_kind);
  if (requested && descriptor.operationKinds.includes(requested)) {
    return requested;
  }

  if (descriptor.execution.kind && descriptor.operationKinds.includes(descriptor.execution.kind)) {
    return descriptor.execution.kind;
  }

  const readFirst = descriptor.operationKinds.find((kind) => !MUTATING_KINDS.has(kind));
  return readFirst ?? descriptor.operationKinds[0] ?? "shell.command";
}

function buildOperationFromDescriptor(
  descriptor: SkillRuntimeDescriptor,
  device: Device,
  input: Record<string, unknown>,
): { operation: OperationSpec } | { error: string } {
  const kind = pickOperationKind(descriptor, input);
  const execution = descriptor.execution;

  const adapterId = typeof input.adapter_id === "string"
    ? input.adapter_id.trim()
    : (execution.adapterId ?? inferAdapterForKind(kind, device));

  const mode = resolveMode(kind, input.mode ?? execution.mode);

  const commandFromInput = typeof input.command_template === "string" ? input.command_template.trim() : "";
  const commandFromKindConfig = execution.commandTemplates?.[kind]?.trim() ?? "";
  const commandFromConfig = execution.commandTemplate?.trim() ?? "";

  const commandTemplate = commandFromInput
    || commandFromKindConfig
    || commandFromConfig
    || defaultCommandTemplate(kind, adapterId, input);

  if (!commandTemplate) {
    return {
      error: `Tool ${descriptor.toolCallName} requires a command template for ${kind}. Provide input.command_template or configure tool execution defaults.`,
    };
  }

  const timeoutRaw = Number(input.timeout_ms ?? execution.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 600_000
    ? Math.floor(timeoutRaw)
    : (mode === "mutate" ? 180_000 : 45_000);

  const expectedSemanticTarget = typeof execution.expectedSemanticTarget === "string" && execution.expectedSemanticTarget.trim().length > 0
    ? execution.expectedSemanticTarget.trim()
    : `${descriptor.skillId}:${kind}`;

  return {
    operation: makeOperation(kind, adapterId, mode, commandTemplate, expectedSemanticTarget, timeoutMs),
  };
}

function actionClassForOperation(operation: OperationSpec): ActionClass {
  return operation.mode === "read" ? "A" : "C";
}

function toSkillExecutionConfig(value: unknown): SkillExecutionConfig {
  if (!isRecord(value)) {
    return {};
  }

  const kind = toOperationKind(value.kind);
  const mode = value.mode === "read" || value.mode === "mutate"
    ? value.mode
    : undefined;

  const adapterId = typeof value.adapterId === "string" && value.adapterId.trim().length > 0
    ? value.adapterId.trim()
    : undefined;

  const timeoutMs = Number(value.timeoutMs);
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000
    ? Math.floor(timeoutMs)
    : undefined;

  const expectedSemanticTarget = typeof value.expectedSemanticTarget === "string"
    ? value.expectedSemanticTarget
    : undefined;

  const commandTemplate = typeof value.commandTemplate === "string"
    ? value.commandTemplate
    : undefined;

  const commandTemplates = isRecord(value.commandTemplates)
    ? Object.fromEntries(
      Object.entries(value.commandTemplates)
        .filter(([k, v]) => isOperationKind(k) && typeof v === "string"),
    ) as Partial<Record<OperationKind, string>>
    : undefined;

  return {
    kind,
    mode,
    adapterId,
    timeoutMs: safeTimeout,
    expectedSemanticTarget,
    commandTemplate,
    commandTemplates,
  };
}

function mapSkillDescriptors(): SkillRuntimeDescriptor[] {
  const records = adapterRegistry
    .getAdapterRecords()
    .filter((record) => record.enabled && record.status === "loaded");

  const descriptors: SkillRuntimeDescriptor[] = [];

  for (const record of records) {
    for (const skill of record.toolSkills) {
      const config = record.toolConfig?.[skill.id];
      if (isRecord(config) && config.enabled === false) {
        continue;
      }

      const toolCallName = skill.toolCall?.name;
      if (!toolCallName || toolCallName.trim().length === 0) {
        continue;
      }

      const mergedExecution = {
        ...toSkillExecutionConfig(((skill as unknown) as Record<string, unknown>).execution),
        ...toSkillExecutionConfig(isRecord(config) ? config.execution : undefined),
      };

      descriptors.push({
        adapterId: record.id,
        adapterName: record.name,
        skillId: skill.id,
        skillName: skill.name,
        operationKinds: (skill.operationKinds ?? ["shell.command"]).slice(0, 8),
        toolCallName,
        toolCallDescription: skill.toolCall?.description ?? skill.description,
        toolCallParameters: skill.toolCall?.parameters ?? {
          type: "object",
          properties: {
            device_id: { type: "string" },
            input: { type: "object", additionalProperties: true },
          },
          required: ["device_id"],
          additionalProperties: true,
        },
        execution: mergedExecution,
      });
    }
  }

  return descriptors;
}

export async function buildAdapterSkillTools(
  options?: { attachedDeviceId?: string; allowPreOnboardingExecution?: boolean },
): Promise<Record<string, ReturnType<typeof dynamicTool>>> {
  await adapterRegistry.initialize();
  const descriptors = mapSkillDescriptors();
  const tools: Record<string, ReturnType<typeof dynamicTool>> = {};

  for (const descriptor of descriptors) {
    tools[descriptor.toolCallName] = dynamicTool({
      description: descriptor.toolCallDescription,
      inputSchema: jsonSchema(descriptor.toolCallParameters),
      execute: async (argsUnknown: unknown) => {
        const args = isRecord(argsUnknown) ? (argsUnknown as ExecuteArgs) : {};
        const input = isRecord(args.input) ? args.input : {};

        const device = await resolveDeviceByTarget(args.device_id, options?.attachedDeviceId);
        if (!device) {
          return {
            ok: false,
            error: "Tool call requires a valid device_id (device id, IP, or exact name).",
          };
        }

        const readiness = validateDeviceReadyForToolUse(device, {
          allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
        });
        if (!readiness.ok) {
          return { ok: false, error: readiness.reason, deviceId: device.id };
        }

        if (!options?.allowPreOnboardingExecution && !hasSelectedBindingForAdapter(device.id, descriptor.adapterId)) {
          return {
            ok: false,
            blocked: "binding",
            error: `Adapter ${descriptor.adapterName} is not selected for ${device.name}. Complete adapter binding in onboarding first.`,
          };
        }

        const planned = buildOperationFromDescriptor(descriptor, device, input);
        if ("error" in planned) {
          return {
            ok: false,
            blocked: "execution_config",
            error: planned.error,
            skillId: descriptor.skillId,
          };
        }

        const operation = planned.operation;
        const actionClass = actionClassForOperation(operation);

        const policy = evaluatePolicy(
          actionClass,
          device,
          stateStore.getPolicyRules(),
          stateStore.getMaintenanceWindows(),
          {
            blastRadius: "single-device",
            criticality: operation.mode === "mutate" ? "high" : "low",
            lane: "A",
            recentFailures: 0,
            quarantineActive: false,
          },
        );

        if (operation.mode === "mutate" && policy.decision !== "ALLOW_AUTO") {
          return {
            ok: false,
            blocked: "policy",
            error: `Policy blocked immediate execution (${policy.decision}): ${policy.reason}`,
            policy,
            deviceId: device.id,
          };
        }

        const adoption = getAdoptionRecord(device);
        const requiredProtocols = Array.isArray(adoption.requiredCredentials)
          ? adoption.requiredCredentials
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.toLowerCase())
          : [];

        if (!options?.allowPreOnboardingExecution && requiredProtocols.includes(operation.adapterId.toLowerCase())) {
          const validated = new Set(
            stateStore.getValidatedCredentialProtocols(device.id).map((value) => value.toLowerCase()),
          );
          if (!validated.has(operation.adapterId.toLowerCase())) {
            return {
              ok: false,
              blocked: "credentials",
              error: `Missing validated credentials for protocol ${operation.adapterId} on ${device.name}.`,
              deviceId: device.id,
            };
          }
        }

        const execution = await executeOperationWithGates(operation, device, {
          actor: "user",
          lane: "A",
          actionClass,
          blastRadius: "single-device",
          policyDecision: policy.decision,
          policyReason: policy.reason,
          approved: true,
          expectedStateHash: computeDeviceStateHash(device),
          runtimeSettings: stateStore.getRuntimeSettings(),
          recentFailures: 0,
          quarantineActive: false,
          idempotencySeed: `${descriptor.skillId}:${device.id}:${nowIso()}`,
          params: {},
        });

        await stateStore.addAction({
          actor: "user",
          kind: "diagnose",
          message: `Adapter skill executed: ${descriptor.skillName} on ${device.name}`,
          context: {
            deviceId: device.id,
            adapterId: descriptor.adapterId,
            adapterName: descriptor.adapterName,
            skillId: descriptor.skillId,
            toolCallName: descriptor.toolCallName,
            operationKind: operation.kind,
            operationMode: operation.mode,
            executionOk: execution.ok,
            policyDecision: policy.decision,
          },
        });

        return {
          ok: execution.ok,
          deviceId: device.id,
          deviceName: device.name,
          adapterId: descriptor.adapterId,
          skillId: descriptor.skillId,
          operationKind: operation.kind,
          operationMode: operation.mode,
          output: execution.output,
          gates: execution.gateResults,
          idempotencyKey: execution.idempotencyKey,
        };
      },
    });
  }

  tools.steward_shell_read = dynamicTool({
    description: "Run an investigative read-only command on an adopted device over SSH/WinRM/Docker.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        device_id: { type: "string", description: "Target device id, name, or IP" },
        command: { type: "string", description: "Read-only command to execute remotely" },
        protocol: { type: "string", description: "Optional protocol override: ssh, winrm, docker" },
      },
      required: ["device_id", "command"],
      additionalProperties: false,
    }),
    execute: async (argsUnknown: unknown) => {
      const args = isRecord(argsUnknown) ? argsUnknown : {};
      const device = await resolveDeviceByTarget(
        typeof args.device_id === "string" ? args.device_id : undefined,
        options?.attachedDeviceId,
      );
      if (!device) {
        return { ok: false, error: "Valid device_id is required." };
      }

      const readiness = validateDeviceReadyForToolUse(device, {
        allowPreOnboardingExecution: options?.allowPreOnboardingExecution,
      });
      if (!readiness.ok) {
        return { ok: false, error: readiness.reason, deviceId: device.id };
      }

      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) {
        return { ok: false, error: "command is required." };
      }

      const requestedProtocol = typeof args.protocol === "string" ? args.protocol.trim().toLowerCase() : "";
      const adapterId = requestedProtocol || inferAdapterForKind("shell.command", device);
      const commandTemplate = defaultCommandTemplate("shell.command", adapterId, { command });
      if (!commandTemplate) {
        return { ok: false, error: `Cannot build command template for adapter ${adapterId}.` };
      }

      const operation = makeOperation(
        "shell.command",
        adapterId,
        "read",
        commandTemplate,
        "steward_shell_read:shell",
        120_000,
      );

      const policy = evaluatePolicy(
        "A",
        device,
        stateStore.getPolicyRules(),
        stateStore.getMaintenanceWindows(),
        {
          blastRadius: "single-device",
          criticality: "low",
          lane: "A",
          recentFailures: 0,
          quarantineActive: false,
        },
      );

      const execution = await executeOperationWithGates(operation, device, {
        actor: "user",
        lane: "A",
        actionClass: "A",
        blastRadius: "single-device",
        policyDecision: policy.decision,
        policyReason: policy.reason,
        approved: true,
        expectedStateHash: computeDeviceStateHash(device),
        runtimeSettings: stateStore.getRuntimeSettings(),
        recentFailures: 0,
        quarantineActive: false,
        idempotencySeed: `steward_shell_read:${device.id}:${nowIso()}`,
        params: {},
      });

      return {
        ok: execution.ok,
        deviceId: device.id,
        deviceName: device.name,
        adapterId,
        output: execution.output,
        gates: execution.gateResults,
      };
    },
  });

  return tools;
}
