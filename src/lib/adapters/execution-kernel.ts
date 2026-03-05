import { createHash } from "node:crypto";
import { z } from "zod";
import { runShell } from "@/lib/utils/shell";
import { capabilityBroker } from "@/lib/security/capability-broker";
import { vault } from "@/lib/security/vault";
import { isLaneAllowed, resolveLaneEnvironment } from "@/lib/execution/lanes";
import { stateStore } from "@/lib/state/store";
import type {
  ActionClass,
  Device,
  ExecutionLane,
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
    "cert.renew",
    "file.copy",
    "network.config",
  ]),
  mode: z.enum(["read", "mutate"]),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  commandTemplate: z.string().optional(),
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
});

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
  idempotencySeed: string;
  params?: Record<string, string>;
}

export interface KernelExecutionResult {
  ok: boolean;
  output: string;
  gateResults: SafetyGateResult[];
  idempotencyKey: string;
  startedAt: string;
  completedAt: string;
}

function interpolate(template: string, device: Device, params: Record<string, string>): string {
  let result = template;
  result = result.replace(/\{\{host\}\}/g, device.ip);
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
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

async function injectCredentialIntoCommand(
  command: string,
  operation: OperationSpec,
  device: Device,
): Promise<string> {
  const adapter = operation.adapterId.toLowerCase();
  if (!(adapter === "ssh" || adapter === "network-ssh" || adapter === "shell")) {
    return command;
  }

  const hostPatterns = [device.ip, device.ip.includes(":") ? `[${device.ip}]` : null]
    .filter((value): value is string => Boolean(value));

  const usesSshHost = hostPatterns.some((host) => command.includes(`ssh ${host}`));
  if (!usesSshHost) {
    return command;
  }

  const candidates = stateStore
    .getDeviceCredentials(device.id)
    .filter((credential) => credential.protocol.toLowerCase() === "ssh")
    .sort((a, b) => {
      const rank = (status: string): number => (status === "validated" ? 0 : status === "provided" ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });

  const credential = candidates[0];
  if (!credential) {
    return command;
  }

  const username = (credential.accountLabel ?? "").trim();
  const hostToken = username.length > 0 ? `${username}@${device.ip}` : device.ip;
  const baseSsh = `ssh -o BatchMode=yes -o StrictHostKeyChecking=no ${hostToken}`;

  let rewritten = command;
  for (const host of hostPatterns) {
    rewritten = rewritten.replace(new RegExp(`ssh\\s+${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), baseSsh);
  }

  const secret = await vault.getSecret(credential.vaultSecretRef);
  if (!secret || secret.trim().length === 0) {
    return rewritten;
  }

  if (process.platform === "win32") {
    const plinkPath = '"C:\\Program Files\\PuTTY\\plink.exe"';
    const sshWithQuotedCommand = /ssh(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+[^\s]+\s+'([^']*)'/;
    const match = rewritten.match(sshWithQuotedCommand);
    if (match?.[1]) {
      const remoteCommand = match[1];
      const plinkCommand = `${plinkPath} -batch -ssh ${hostToken} -pw "${shellEscapeDoubleQuoted(secret)}" "${shellEscapeDoubleQuoted(remoteCommand)}"`;
      return rewritten.replace(sshWithQuotedCommand, plinkCommand);
    }

    const plinkPrefix = `${plinkPath} -batch -ssh ${hostToken} -pw "${shellEscapeDoubleQuoted(secret)}"`;
    const sshCommandPattern = /ssh(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+[^\s]+/;
    return rewritten.replace(sshCommandPattern, plinkPrefix);
  }

  if (rewritten.includes("sshpass -p")) {
    return rewritten;
  }

  return `sshpass -p '${shellEscapeSingleQuoted(secret)}' ${rewritten}`;
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
  return parsed as OperationSpec;
}

const ADAPTER_ALIASES: Record<string, string[]> = {
  ssh: ["ssh"],
  winrm: ["winrm", "rdp"],
  docker: ["docker"],
  "http-api": ["http", "https", "http-api"],
  snmp: ["snmp"],
  "network-ssh": ["ssh"],
  shell: ["ssh", "winrm", "docker", "http-api"],
};

function adapterMatchesDevice(operation: OperationSpec, device: Device): boolean {
  const aliases = ADAPTER_ALIASES[operation.adapterId] ?? [operation.adapterId];
  return aliases.some((alias) => device.protocols.includes(alias));
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
): Promise<{ ok: boolean; output: string }> {
  const commandTemplate = operation.commandTemplate;
  if (!commandTemplate) {
    return { ok: false, output: "Operation missing commandTemplate" };
  }

  const command = interpolate(commandTemplate, device, params);
  const commandWithCredential = await injectCredentialIntoCommand(command, operation, device);
  const result = await runShell(commandWithCredential, operation.timeoutMs);
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
): Promise<{ ok: boolean; output: string }> {
  if (!operation.safety.dryRunSupported) {
    return { ok: true, output: "dry-run: not supported" };
  }

  const dryTemplate = operation.safety.dryRunCommandTemplate;
  if (!dryTemplate) {
    return { ok: false, output: "dry-run required but dryRunCommandTemplate is missing" };
  }

  const command = interpolate(dryTemplate, device, params);
  const result = await runShell(command, Math.min(operation.timeoutMs, 45_000));
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

  let operation: OperationSpec;
  try {
    operation = normalizeOperation(operationInput);
    gateResults.push(gate("schema", true, "Operation schema valid"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gateResults.push(gate("schema", false, `Schema validation failed: ${message}`));
    return {
      ok: false,
      output: message,
      gateResults,
      idempotencyKey: `${context.idempotencySeed}:schema-failed`,
      startedAt,
      completedAt: nowIso(),
    };
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
    return {
      ok: false,
      output: laneDecision.reason,
      gateResults,
      idempotencyKey: `${context.idempotencySeed}:lane-blocked`,
      startedAt,
      completedAt: nowIso(),
    };
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
    return {
      ok: false,
      output: "OCC state-hash mismatch",
      gateResults,
      idempotencyKey: `${context.idempotencySeed}:state-hash-mismatch`,
      startedAt,
      completedAt: nowIso(),
    };
  }

  const policyAllowed =
    context.policyDecision === "ALLOW_AUTO"
    || (context.policyDecision === "REQUIRE_APPROVAL" && context.approved);

  const policyFailureReason = context.policyDecision === "DENY"
    ? `Policy denied operation: ${context.policyReason}`
    : context.policyDecision === "REQUIRE_APPROVAL" && !context.approved
      ? "Policy requires approval before execution"
      : "Policy allowed";

  const semanticOk = adapterMatchesDevice(operation, device);
  const semanticTarget = operation.expectedSemanticTarget
    ? interpolate(operation.expectedSemanticTarget, device, params)
    : undefined;
  const semanticTargetResolved = semanticTarget ? !semanticTarget.includes("{{") : true;
  const revertOk = hasSafeNetworkRevert(operation);
  const policyGateOk = policyAllowed && semanticOk && semanticTargetResolved && revertOk && !context.quarantineActive;
  gateResults.push(
    gate(
      "policy",
      policyGateOk,
      policyGateOk ? "Policy and semantic checks passed" : policyFailureReason,
      {
        policyDecision: context.policyDecision,
        semanticOk,
        semanticTarget,
        semanticTargetResolved,
        revertOk,
        quarantineActive: context.quarantineActive,
      },
    ),
  );

  if (!policyGateOk) {
    return {
      ok: false,
      output: policyFailureReason,
      gateResults,
      idempotencyKey: `${context.idempotencySeed}:policy-blocked`,
      startedAt,
      completedAt: nowIso(),
    };
  }

  if (operation.mode === "mutate" && context.runtimeSettings.mutationRequireDryRunWhenSupported) {
    const dryRun = await dryRunIfSupported(operation, device, params);
    gateResults.push(
      gate(
        "dry_run",
        dryRun.ok,
        dryRun.ok ? "Dry-run gate passed" : "Dry-run gate failed",
        { output: dryRun.output },
      ),
    );

    if (!dryRun.ok) {
      return {
        ok: false,
        output: dryRun.output,
        gateResults,
        idempotencyKey: `${context.idempotencySeed}:dry-run-failed`,
        startedAt,
        completedAt: nowIso(),
      };
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

  const execution = await runOperationCommand(operation, device, params);
  const idempotencyKey = createHash("sha256")
    .update(`${context.idempotencySeed}:${operation.id}:${context.expectedStateHash}`)
    .digest("hex");

  return {
    ok: execution.ok,
    output: execution.output,
    gateResults,
    idempotencyKey,
    startedAt,
    completedAt: nowIso(),
  };
}
