import { createHash } from "node:crypto";
import { z } from "zod";
import { runShell } from "@/lib/utils/shell";
import { executeBrokerOperation } from "@/lib/adapters/protocol-broker";
import { parseWinrmCommandTemplate } from "@/lib/adapters/winrm";
import { interpolateOperationValue } from "@/lib/adapters/execution-template";
import { capabilityBroker } from "@/lib/security/capability-broker";
import { vault } from "@/lib/security/vault";
import { isLaneAllowed, resolveLaneEnvironment } from "@/lib/execution/lanes";
import { stateStore } from "@/lib/state/store";
import type {
  ActionClass,
  Device,
  DeviceCredential,
  ExecutionLane,
  OperationExecutionPhase,
  OperationExecutionProof,
  OperationExecutionStatus,
  OperationSpec,
  PolicyDecision,
  RuntimeSettings,
  SafetyGateResult,
} from "@/lib/state/types";

const OperationSchema = z.object({
  id: z.string().min(1),
  adapterId: z.string().min(1),
  kind: z.enum([
    "shell.command",
    "service.restart",
    "service.stop",
    "container.restart",
    "container.stop",
    "http.request",
    "websocket.message",
    "mqtt.message",
    "cert.renew",
    "file.copy",
    "network.config",
  ]),
  mode: z.enum(["read", "mutate"]),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  commandTemplate: z.string().optional(),
  brokerRequest: z.discriminatedUnion("protocol", [
    z.object({
      protocol: z.literal("ssh"),
      argv: z.array(z.string()).min(1),
      port: z.number().int().min(1).max(65535).optional(),
    }),
    z.object({
      protocol: z.literal("http"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      scheme: z.enum(["http", "https"]).optional(),
      schemes: z.array(z.enum(["http", "https"])).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      path: z.string().min(1),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      insecureSkipVerify: z.boolean().optional(),
      expectRegex: z.string().optional(),
    }),
    z.object({
      protocol: z.literal("websocket"),
      scheme: z.enum(["ws", "wss"]).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      path: z.string().min(1),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      protocols: z.array(z.string()).optional(),
      messages: z.array(z.string()).optional(),
      sendOn: z.enum(["open", "first-message"]).optional(),
      connectTimeoutMs: z.number().int().min(250).max(120_000).optional(),
      responseTimeoutMs: z.number().int().min(250).max(120_000).optional(),
      collectMessages: z.number().int().min(1).max(50).optional(),
      expectRegex: z.string().optional(),
      successStrategy: z.enum(["auto", "transport", "response", "expectation"]).optional(),
    }),
    z.object({
      protocol: z.literal("mqtt"),
      scheme: z.enum(["mqtt", "mqtts"]).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      clientId: z.string().min(1).optional(),
      username: z.string().min(1).optional(),
      clean: z.boolean().optional(),
      qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      retain: z.boolean().optional(),
      subscribeTopics: z.array(z.string().min(1)).optional(),
      publishMessages: z.array(z.object({
        topic: z.string().min(1),
        payload: z.string().optional(),
        qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        retain: z.boolean().optional(),
      })).optional(),
      connectTimeoutMs: z.number().int().min(250).max(120_000).optional(),
      responseTimeoutMs: z.number().int().min(250).max(120_000).optional(),
      collectMessages: z.number().int().min(0).max(50).optional(),
      keepaliveSec: z.number().int().min(5).max(1_200).optional(),
      expectRegex: z.string().optional(),
      successStrategy: z.enum(["auto", "transport", "response", "expectation"]).optional(),
      insecureSkipVerify: z.boolean().optional(),
      sessionId: z.string().min(1).optional(),
      sessionHolder: z.string().min(1).optional(),
      leaseTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
      keepSessionOpen: z.boolean().optional(),
      arbitrationMode: z.enum(["shared", "exclusive", "single-connection"]).optional(),
      singleConnectionHint: z.boolean().optional(),
    }),
    z.object({
      protocol: z.literal("local-tool"),
      toolId: z.string().min(1),
      command: z.string().min(1),
      argv: z.array(z.string()).optional(),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000).optional(),
      installIfMissing: z.boolean().optional(),
      healthCheckBeforeRun: z.boolean().optional(),
      approvalReason: z.string().min(1).optional(),
    }),
    z.object({
      protocol: z.literal("winrm"),
      command: z.string().min(1),
      port: z.number().int().min(1).max(65535).optional(),
      useSsl: z.boolean().optional(),
      skipCertChecks: z.boolean().optional(),
      authentication: z.string().min(1).optional(),
      expectRegex: z.string().optional(),
    }),
  ]).optional(),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  expectedSemanticTarget: z.string().optional(),
  safety: z.object({
    dryRunSupported: z.boolean(),
    dryRunCommandTemplate: z.string().optional(),
    requiresConfirmedRevert: z.boolean(),
    revertMechanism: z.enum(["commit-confirmed", "timed-rollback", "manual"]).optional(),
    riskTags: z.array(z.string()).optional(),
    criticality: z.enum(["low", "medium", "high"]).optional(),
  }),
}).refine(
  (operation) => Boolean(operation.commandTemplate) || Boolean(operation.brokerRequest),
  "Operation must define commandTemplate or brokerRequest",
);

export interface KernelExecutionContext {
  actor: "steward" | "user";
  lane: ExecutionLane;
  actionClass: ActionClass;
  blastRadius: "single-service" | "single-device" | "multi-device";
  policyDecision: PolicyDecision;
  policyReason: string;
  approved: boolean;
  expectedStateHash: string;
  runtimeSettings: RuntimeSettings;
  recentFailures: number;
  quarantineActive: boolean;
  allowUnauthenticated?: boolean;
  allowProvidedCredentials?: boolean;
  idempotencySeed: string;
  playbookRunId?: string;
  params?: Record<string, string>;
}

export interface KernelExecutionResult {
  ok: boolean;
  status: OperationExecutionStatus;
  phase: OperationExecutionPhase;
  proof: OperationExecutionProof;
  summary: string;
  output: string;
  details: Record<string, unknown>;
  gateResults: SafetyGateResult[];
  idempotencyKey: string;
  startedAt: string;
  completedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function shellEscapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\"'\"'");
}

function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/"/g, '\\"');
}

function selectCredentialForExecution(
  device: Device,
  context: KernelExecutionContext,
): { credential?: DeviceCredential; availableStatuses: string[] } {
  const candidates = stateStore
    .getDeviceCredentials(device.id)
    .filter((credential) => credential.protocol.toLowerCase() === "ssh");
  const availableStatuses = Array.from(new Set(candidates.map((credential) => credential.status)));
  const priority = ["validated", "provided", "invalid", "pending"] as const;
  const sorted = [...candidates].sort((a, b) => {
    const aPriority = priority.indexOf(a.status as (typeof priority)[number]);
    const bPriority = priority.indexOf(b.status as (typeof priority)[number]);
    if (aPriority !== bPriority) {
      return (aPriority === -1 ? 99 : aPriority) - (bPriority === -1 ? 99 : bPriority);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const credential = sorted[0]
    ?? (context.allowProvidedCredentials ? candidates.find((item) => item.status === "provided") : undefined);
  return { credential, availableStatuses };
}

async function injectCredentialIntoCommand(
  command: string,
  operation: OperationSpec,
  device: Device,
  context: KernelExecutionContext,
): Promise<
  | { ok: true; command: string }
  | { ok: false; output: string }
> {
  const adapter = operation.adapterId.toLowerCase();
  if (!(adapter === "ssh" || adapter === "network-ssh" || adapter === "shell")) {
    return { ok: true, command };
  }

  const hostPatterns = [device.ip, device.ip.includes(":") ? `[${device.ip}]` : null]
    .filter((value): value is string => Boolean(value));

  const usesSshHost = hostPatterns.some((host) => command.includes(`ssh ${host}`));
  if (!usesSshHost) {
    return { ok: true, command };
  }

  const { credential, availableStatuses } = selectCredentialForExecution(device, context);
  if (!credential) {
    stateStore.logCredentialAccess({
      deviceId: device.id,
      protocol: "ssh",
      playbookRunId: context.playbookRunId,
      operationId: operation.id,
      adapterId: operation.adapterId,
      actor: context.actor,
      purpose: operation.kind,
      result: availableStatuses.length > 0 ? "credential_unusable" : "no_stored_credential",
      details: {
        allowedStatuses: ["pending", "provided", "validated", "invalid"],
        availableStatuses,
      },
    });
    return {
      ok: false,
      output: "SSH command requires a stored Steward credential. Ambient SSH usernames, keys, and agent state are not used.",
    };
  }

  const username = (credential.accountLabel ?? "").trim();
  if (username.length === 0) {
    stateStore.logCredentialAccess({
      credentialId: credential.id,
      deviceId: device.id,
      protocol: credential.protocol,
      playbookRunId: context.playbookRunId,
      operationId: operation.id,
      adapterId: operation.adapterId,
      actor: context.actor,
      purpose: operation.kind,
      result: "credential_unusable",
      details: {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
        reason: "missing_account_label",
      },
    });
    return {
      ok: false,
      output: "Stored SSH credential is missing an account username.",
    };
  }

  const hostToken = username.length > 0 ? `${username}@${device.ip}` : device.ip;
  const baseSsh = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${hostToken}`;

  let rewritten = command;
  for (const host of hostPatterns) {
    rewritten = rewritten.replace(new RegExp(`ssh\\s+${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), baseSsh);
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (!secret || secret.trim().length === 0) {
    stateStore.logCredentialAccess({
      credentialId: credential.id,
      deviceId: device.id,
      protocol: credential.protocol,
      playbookRunId: context.playbookRunId,
      operationId: operation.id,
      adapterId: operation.adapterId,
      actor: context.actor,
      purpose: operation.kind,
      result: "missing_secret",
      details: {
        accountLabel: credential.accountLabel ?? null,
        credentialStatus: credential.status,
      },
    });
    return {
      ok: false,
      output: "Stored SSH credential is missing a usable secret.",
    };
  }

  stateStore.logCredentialAccess({
    credentialId: credential.id,
    deviceId: device.id,
    protocol: credential.protocol,
    playbookRunId: context.playbookRunId,
    operationId: operation.id,
    adapterId: operation.adapterId,
    actor: context.actor,
    purpose: operation.kind,
    result: "granted",
    details: {
      accountLabel: credential.accountLabel ?? null,
      credentialStatus: credential.status,
    },
  });

  if (process.platform === "win32") {
    const plinkPath = '"C:\\Program Files\\PuTTY\\plink.exe"';
    const sshWithQuotedCommand = /ssh(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+[^\s]+\s+'([^']*)'/;
    const match = rewritten.match(sshWithQuotedCommand);
    if (match?.[1]) {
      const remoteCommand = match[1];
      const plinkCommand = `${plinkPath} -batch -ssh ${hostToken} -pw "${shellEscapeDoubleQuoted(secret)}" "${shellEscapeDoubleQuoted(remoteCommand)}"`;
      return { ok: true, command: rewritten.replace(sshWithQuotedCommand, plinkCommand) };
    }

    const plinkPrefix = `${plinkPath} -batch -ssh ${hostToken} -pw "${shellEscapeDoubleQuoted(secret)}"`;
    const sshCommandPattern = /ssh(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+[^\s]+/;
    return { ok: true, command: rewritten.replace(sshCommandPattern, plinkPrefix) };
  }

  if (rewritten.includes("sshpass -p")) {
    return { ok: true, command: rewritten };
  }

  return { ok: true, command: `sshpass -p '${shellEscapeSingleQuoted(secret)}' ${rewritten}` };
}

function gate(
  gateName: SafetyGateResult["gate"],
  passed: boolean,
  message: string,
  details?: Record<string, unknown>,
): SafetyGateResult {
  return {
    gate: gateName,
    passed,
    message,
    at: nowIso(),
    details,
  };
}

function normalizeOperation(operation: OperationSpec): OperationSpec {
  const parsed = OperationSchema.parse(operation);
  const normalized = parsed as OperationSpec;
  const adapterId = normalized.adapterId.toLowerCase();
  if (normalized.brokerRequest || !normalized.commandTemplate || !(adapterId === "winrm" || adapterId === "shell")) {
    return normalized;
  }

  const inferredBrokerRequest = parseWinrmCommandTemplate(normalized.commandTemplate);
  if (!inferredBrokerRequest) {
    return normalized;
  }

  return {
    ...normalized,
    brokerRequest: inferredBrokerRequest,
  };
}

const ADAPTER_ALIASES: Record<string, string[]> = {
  ssh: ["ssh"],
  winrm: ["winrm"],
  docker: ["docker"],
  "http-api": ["http", "https", "http-api"],
  mqtt: ["mqtt"],
  snmp: ["snmp"],
  "network-ssh": ["ssh"],
  shell: ["ssh", "winrm", "docker", "http-api"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectSemanticProtocols(device: Device): Set<string> {
  const protocols = new Set(device.protocols.map((protocol) => protocol.toLowerCase()));

  for (const protocol of stateStore.getValidatedCredentialProtocols(device.id)) {
    const normalized = protocol.trim().toLowerCase();
    if (normalized) {
      protocols.add(normalized);
    }
  }

  const metadata = isRecord(device.metadata) ? device.metadata : null;
  const managementSurface = metadata && isRecord(metadata.managementSurface)
    ? metadata.managementSurface
    : null;
  const preferredProtocol = typeof managementSurface?.preferredProtocol === "string"
    ? managementSurface.preferredProtocol.trim().toLowerCase()
    : "";

  if (preferredProtocol) {
    protocols.add(preferredProtocol);
  }

  const capabilities = Array.isArray(managementSurface?.capabilities)
    ? managementSurface.capabilities
    : [];
  for (const capability of capabilities) {
    if (!isRecord(capability) || typeof capability.protocol !== "string") {
      continue;
    }
    const normalized = capability.protocol.trim().toLowerCase();
    if (normalized) {
      protocols.add(normalized);
    }
  }

  return protocols;
}

function adapterMatchesDevice(operation: OperationSpec, device: Device): boolean {
  if (operation.brokerRequest?.protocol === "local-tool" || operation.adapterId.startsWith("local-tool")) {
    return true;
  }

  const aliases = ADAPTER_ALIASES[operation.adapterId] ?? [operation.adapterId];
  const semanticProtocols = collectSemanticProtocols(device);
  if (aliases.some((alias) => semanticProtocols.has(alias))) {
    return true;
  }

  return aliases.some((alias) => {
    if (alias === "http-api") {
      return device.services.some((service) =>
        service.transport === "tcp"
        && (service.secure || /http|https|web|api/i.test(service.name) || [80, 443, 8000, 8001, 8002, 8080, 8443].includes(service.port)),
      );
    }

    if (alias === "ssh") {
      return device.services.some((service) =>
        service.transport === "tcp"
        && (service.port === 22 || service.port === 2222 || /ssh/i.test(service.name)),
      );
    }

    if (alias === "winrm") {
      return device.services.some((service) =>
        service.transport === "tcp"
        && (service.port === 5985 || service.port === 5986 || /winrm/i.test(service.name)),
      );
    }

    if (alias === "docker") {
      return device.services.some((service) =>
        service.transport === "tcp"
        && (service.port === 2375 || service.port === 2376 || /docker/i.test(service.name)),
      );
    }

    if (alias === "mqtt") {
      return device.services.some((service) =>
        service.transport === "tcp"
        && (service.port === 1883 || service.port === 8883 || /mqtt/i.test(service.name)),
      );
    }

    if (alias === "snmp") {
      return device.services.some((service) =>
        (service.transport === "udp" || service.transport === "tcp")
        && (service.port === 161 || service.port === 162 || /snmp/i.test(service.name)),
      );
    }

    return false;
  });
}

function hasSafeNetworkRevert(operation: OperationSpec): boolean {
  if (operation.kind !== "network.config" || operation.mode !== "mutate") {
    return true;
  }
  return Boolean(
    operation.safety.requiresConfirmedRevert
      && (operation.safety.revertMechanism === "commit-confirmed"
        || operation.safety.revertMechanism === "timed-rollback"),
  );
}

export function computeDeviceStateHash(device: Device): string {
  const canonical = JSON.stringify({
    id: device.id,
    ip: device.ip,
    status: device.status,
    protocols: [...device.protocols].sort(),
    services: device.services
      .map((service) => ({ id: service.id, port: service.port, name: service.name, lastSeenAt: service.lastSeenAt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    lastSeenAt: device.lastSeenAt,
    lastChangedAt: device.lastChangedAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function runOperationCommand(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: KernelExecutionContext,
): Promise<{ ok: boolean; output: string }> {
  const commandTemplate = operation.commandTemplate;
  if (!commandTemplate) {
    return { ok: false, output: "Operation missing commandTemplate" };
  }

  const command = interpolateOperationValue(commandTemplate, device.ip, params);
  const commandWithCredential = await injectCredentialIntoCommand(command, operation, device, context);
  if (!commandWithCredential.ok) {
    return { ok: false, output: commandWithCredential.output };
  }
  const result = await runShell(commandWithCredential.command, operation.timeoutMs);
  const output = `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim();

  if (!result.ok) {
    return {
      ok: false,
      output: `${output}\n[exit code: ${result.code}]`.trim(),
    };
  }

  return {
    ok: true,
    output,
  };
}

async function dryRunIfSupported(
  operation: OperationSpec,
  device: Device,
  params: Record<string, string>,
  context: KernelExecutionContext,
): Promise<{ ok: boolean; output: string }> {
  if (!operation.safety.dryRunSupported) {
    return { ok: true, output: "dry-run: not supported" };
  }

  const dryTemplate = operation.safety.dryRunCommandTemplate;
  if (!dryTemplate) {
    return { ok: false, output: "dry-run required but dryRunCommandTemplate is missing" };
  }

  const command = interpolateOperationValue(dryTemplate, device.ip, params);
  const commandWithCredential = await injectCredentialIntoCommand(command, operation, device, context);
  if (!commandWithCredential.ok) {
    return { ok: false, output: commandWithCredential.output };
  }
  const result = await runShell(commandWithCredential.command, Math.min(operation.timeoutMs, 45_000));
  const output = `${result.stdout}${result.stderr ? `\n[stderr] ${result.stderr}` : ""}`.trim();

  if (!result.ok) {
    return {
      ok: false,
      output: `${output}\n[dry-run exit code: ${result.code}]`.trim(),
    };
  }

  return { ok: true, output: output || "dry-run: ok" };
}

export async function executeOperationWithGates(
  operationInput: OperationSpec,
  device: Device,
  context: KernelExecutionContext,
): Promise<KernelExecutionResult> {
  const startedAt = nowIso();
  const gateResults: SafetyGateResult[] = [];
  const params = context.params ?? {};
  const finish = (input: {
    ok: boolean;
    status: OperationExecutionStatus;
    phase: OperationExecutionPhase;
    proof: OperationExecutionProof;
    summary: string;
    output: string;
    details?: Record<string, unknown>;
    idempotencyKey: string;
  }): KernelExecutionResult => ({
    ok: input.ok,
    status: input.status,
    phase: input.phase,
    proof: input.proof,
    summary: input.summary,
    output: input.output,
    details: input.details ?? {},
    gateResults,
    idempotencyKey: input.idempotencyKey,
    startedAt,
    completedAt: nowIso(),
  });

  let operation: OperationSpec;
  try {
    operation = normalizeOperation(operationInput);
    gateResults.push(gate("schema", true, "Operation schema valid"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gateResults.push(gate("schema", false, `Schema validation failed: ${message}`));
    return finish({
      ok: false,
      status: "failed",
      phase: "not-started",
      proof: "none",
      summary: "Operation schema validation failed",
      output: message,
      details: { gate: "schema" },
      idempotencyKey: `${context.idempotencySeed}:schema-failed`,
    });
  }

  const laneDecision = isLaneAllowed(
    {
      lane: context.lane,
      environment: resolveLaneEnvironment(device),
      isMutation: operation.mode === "mutate",
    },
    context.runtimeSettings,
  );

  if (!laneDecision.allowed) {
    gateResults.push(gate("policy", false, laneDecision.reason, { lane: context.lane }));
    return finish({
      ok: false,
      status: "blocked",
      phase: "blocked",
      proof: "none",
      summary: "Execution lane blocked operation",
      output: laneDecision.reason,
      details: { gate: "policy", lane: context.lane },
      idempotencyKey: `${context.idempotencySeed}:lane-blocked`,
    });
  }

  const currentStateHash = computeDeviceStateHash(device);
  const occOk = currentStateHash === context.expectedStateHash;
  gateResults.push(
    gate(
      "state_hash",
      occOk,
      occOk ? "State hash matched" : "State hash conflict; re-plan required",
      { expected: context.expectedStateHash, actual: currentStateHash },
    ),
  );
  if (!occOk) {
    return finish({
      ok: false,
      status: "blocked",
      phase: "blocked",
      proof: "none",
      summary: "State hash mismatch blocked execution",
      output: "OCC state-hash mismatch",
      details: { gate: "state_hash" },
      idempotencyKey: `${context.idempotencySeed}:state-hash-mismatch`,
    });
  }

  const policyAllowed =
    context.policyDecision === "ALLOW_AUTO"
    || (context.policyDecision === "REQUIRE_APPROVAL" && context.approved);

  const semanticObservedMatch = adapterMatchesDevice(operation, device);
  const semanticOk = operation.mode === "read" ? true : semanticObservedMatch;
  const semanticTarget = operation.expectedSemanticTarget
    ? interpolateOperationValue(operation.expectedSemanticTarget, device.ip, params)
    : undefined;
  const semanticTargetResolved = semanticTarget ? !semanticTarget.includes("{{") : true;
  const revertOk = hasSafeNetworkRevert(operation);
  const policyFailureReason = context.policyDecision === "DENY"
    ? `Policy denied operation: ${context.policyReason}`
    : context.policyDecision === "REQUIRE_APPROVAL" && !context.approved
      ? "Policy requires approval before execution"
      : !semanticOk
        ? `Semantic check failed: adapter ${operation.adapterId} does not match known capabilities for ${device.name}`
        : !semanticTargetResolved
          ? "Semantic target interpolation failed"
          : !revertOk
            ? "Unsafe network operation blocked: missing confirmed revert path"
            : context.quarantineActive
              ? "Execution blocked: quarantine is active"
              : "Policy allowed";
  const policyGateOk = policyAllowed && semanticOk && semanticTargetResolved && revertOk && !context.quarantineActive;
  gateResults.push(
    gate(
      "policy",
      policyGateOk,
      policyGateOk ? "Policy and semantic checks passed" : policyFailureReason,
      {
        policyDecision: context.policyDecision,
        semanticOk,
        semanticObservedMatch,
        semanticTarget,
        semanticTargetResolved,
        revertOk,
        quarantineActive: context.quarantineActive,
      },
    ),
  );

  if (!policyGateOk) {
    return finish({
      ok: false,
      status: "blocked",
      phase: "blocked",
      proof: "none",
      summary: "Policy gate blocked execution",
      output: policyFailureReason,
      details: {
        gate: "policy",
        policyDecision: context.policyDecision,
        policyReason: context.policyReason,
      },
      idempotencyKey: `${context.idempotencySeed}:policy-blocked`,
    });
  }

  if (operation.mode === "mutate" && context.runtimeSettings.mutationRequireDryRunWhenSupported) {
    const dryRun = await dryRunIfSupported(operation, device, params, context);
    gateResults.push(
      gate(
        "dry_run",
        dryRun.ok,
        dryRun.ok ? "Dry-run gate passed" : "Dry-run gate failed",
        { output: dryRun.output },
      ),
    );

    if (!dryRun.ok) {
      return finish({
        ok: false,
        status: "failed",
        phase: "executed",
        proof: "process",
        summary: "Dry-run gate failed",
        output: dryRun.output,
        details: { gate: "dry_run" },
        idempotencyKey: `${context.idempotencySeed}:dry-run-failed`,
      });
    }
  } else {
    gateResults.push(gate("dry_run", true, "Dry-run gate skipped"));
  }

  const capability = capabilityBroker.issue(
    {
      deviceId: device.id,
      adapterId: operation.adapterId,
      operationKinds: [operation.kind],
      mode: operation.mode,
    },
    60_000,
  );

  capabilityBroker.validate(capability.token, {
    deviceId: device.id,
    adapterId: operation.adapterId,
    operationKinds: [operation.kind],
    mode: operation.mode,
  });

  const brokerExecution = await executeBrokerOperation(operation, device, params, {
    actor: context.actor,
    playbookRunId: context.playbookRunId,
    allowUnauthenticated: context.allowUnauthenticated,
    allowProvidedCredentials: context.allowProvidedCredentials,
  });
  const execution = brokerExecution.handled
    ? brokerExecution
    : await (async () => {
      const commandExecution = await runOperationCommand(operation, device, params, context);
      return {
        ok: commandExecution.ok,
        status: commandExecution.ok ? "succeeded" as const : "failed" as const,
        phase: "executed" as const,
        proof: "process" as const,
        summary: commandExecution.ok ? "Command completed successfully" : "Command execution failed",
        output: commandExecution.output,
        details: {},
      };
    })();
  const idempotencyKey = createHash("sha256")
    .update(`${context.idempotencySeed}:${operation.id}:${context.expectedStateHash}`)
    .digest("hex");

  return finish({
    ok: execution.ok,
    status: execution.status,
    phase: execution.phase,
    proof: execution.proof,
    summary: execution.summary,
    output: execution.output,
    details: execution.details,
    idempotencyKey,
  });
}
