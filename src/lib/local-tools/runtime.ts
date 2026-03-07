import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "@/lib/state/db";
import { stateStore } from "@/lib/state/store";
import type {
  LocalToolApproval,
  LocalToolApprovalAction,
  LocalToolExecutionRequest,
  LocalToolExecutionResult,
  LocalToolManifest,
  LocalToolRecord,
  LocalToolStatus,
  RuntimeSettings,
} from "@/lib/state/types";
import { runCommand } from "@/lib/utils/shell";

export interface LocalToolActionResult {
  ok: boolean;
  status: "succeeded" | "blocked" | "failed";
  tool?: LocalToolRecord;
  approval?: LocalToolApproval;
  summary: string;
  error?: string;
}

interface LocalToolHealthResult {
  ok: boolean;
  tool: LocalToolRecord;
  summary: string;
}

interface ApprovalDecision {
  allowed: boolean;
  denied?: boolean;
  reason?: string;
  approval?: LocalToolApproval;
}

function nowIso(): string {
  return new Date().toISOString();
}

function localToolsRoot(): string {
  const dir = path.join(getDataDir(), "local-tools");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function installDirForTool(toolId: string): string {
  return path.join(localToolsRoot(), toolId);
}

function safeJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function stableRequestSignature(value: Record<string, unknown>): string {
  return safeJson(Object.keys(value).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = value[key];
    return acc;
  }, {}));
}

function manifestIsSafe(manifest: LocalToolManifest): boolean {
  return manifest.risk === "low"
    && manifest.runtimeHints?.interactive !== true
    && manifest.runtimeHints?.singleConnectionRisk !== true;
}

function resolvePolicy(
  runtime: RuntimeSettings,
  action: LocalToolApprovalAction,
): RuntimeSettings["localToolInstallPolicy"] {
  return action === "execute" ? runtime.localToolExecutionPolicy : runtime.localToolInstallPolicy;
}

function packageVersionFromDisk(installDir: string, manifest: LocalToolManifest): string | undefined {
  if (!manifest.packageName) {
    return undefined;
  }
  const pkgPath = path.join(installDir, "node_modules", manifest.packageName, "package.json");
  if (!existsSync(pkgPath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim().length > 0 ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

function ensureInstallScaffold(toolId: string, manifest: LocalToolManifest): string {
  const installDir = installDirForTool(toolId);
  mkdirSync(installDir, { recursive: true });
  const pkgPath = path.join(installDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      `${JSON.stringify({
        name: `steward-local-tool-${toolId}`,
        private: true,
        description: manifest.description,
      }, null, 2)}\n`,
      "utf8",
    );
  }
  return installDir;
}

function resolveBinaryPath(tool: LocalToolRecord, command: string): string | undefined {
  if (tool.binPaths[command]) {
    return tool.binPaths[command];
  }
  const byName = tool.manifest.bins.find((bin) => bin.name === command || bin.bin === command);
  if (byName && tool.binPaths[byName.name]) {
    return tool.binPaths[byName.name];
  }
  if (tool.manifest.sourceKind === "binary-path" && tool.manifest.binaryPath) {
    return tool.manifest.binaryPath;
  }
  return undefined;
}

function defaultRecordForManifest(manifest: LocalToolManifest): LocalToolRecord {
  const now = nowIso();
  return {
    id: manifest.id,
    manifest,
    enabled: true,
    status: "not_installed",
    healthStatus: "unknown",
    installDir: manifest.sourceKind === "npm-package" ? installDirForTool(manifest.id) : undefined,
    binPaths: {},
    createdAt: now,
    updatedAt: now,
  };
}

function mergeManifest(record: LocalToolRecord, manifest: LocalToolManifest): LocalToolRecord {
  return {
    ...record,
    manifest,
    installDir: record.installDir ?? (manifest.sourceKind === "npm-package" ? installDirForTool(manifest.id) : undefined),
    updatedAt: nowIso(),
  };
}

class LocalToolRuntime {
  private initialized = false;
  private initializing: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      this.initialized = true;
      this.initializing = null;
    })();

    await this.initializing;
  }

  listTools(): LocalToolRecord[] {
    void this.initialize();
    return stateStore.getLocalTools();
  }

  getTool(id: string): LocalToolRecord | undefined {
    void this.initialize();
    return stateStore.getLocalToolById(id);
  }

  registerManifest(manifest: LocalToolManifest): LocalToolRecord {
    const existing = stateStore.getLocalToolById(manifest.id);
    const record = existing ? mergeManifest(existing, manifest) : defaultRecordForManifest(manifest);
    return stateStore.upsertLocalTool(record);
  }

  listApprovals(filter?: { toolId?: string; status?: LocalToolApproval["status"] }): LocalToolApproval[] {
    void this.initialize();
    return stateStore.getLocalToolApprovals(filter);
  }

  private requestApproval(
    tool: LocalToolRecord,
    action: LocalToolApprovalAction,
    requestedBy: LocalToolApproval["requestedBy"],
    reason: string,
    requestJson: Record<string, unknown>,
  ): LocalToolApproval {
    const runtime = stateStore.getRuntimeSettings();
    const expiresAt = new Date(Date.now() + runtime.localToolApprovalTtlMs).toISOString();
    const signature = stableRequestSignature(requestJson);
    const existing = stateStore.getLocalToolApprovals({ toolId: tool.id })
      .find((approval) =>
        approval.action === action
        && approval.status === "pending"
        && stableRequestSignature(approval.requestJson) === signature
        && (!approval.expiresAt || approval.expiresAt > nowIso())
      );
    if (existing) {
      return existing;
    }

    const approval: LocalToolApproval = {
      id: randomUUID(),
      toolId: tool.id,
      action,
      status: "pending",
      requestedBy,
      requestedAt: nowIso(),
      expiresAt,
      reason,
      requestJson,
      decisionJson: {},
    };
    stateStore.upsertLocalToolApproval(approval);
    void stateStore.addAction({
      actor: requestedBy,
      kind: "approval",
      message: `Local tool approval requested for ${tool.id} (${action})`,
      context: {
        toolId: tool.id,
        action,
        reason,
      },
    });
    return approval;
  }

  private evaluateApproval(
    tool: LocalToolRecord,
    action: LocalToolApprovalAction,
    requestJson: Record<string, unknown>,
    reason: string,
    requestedBy: LocalToolApproval["requestedBy"],
  ): ApprovalDecision {
    const runtime = stateStore.getRuntimeSettings();
    const policy = resolvePolicy(runtime, action);
    if (policy === "deny") {
      return { allowed: false, denied: true, reason: `Runtime policy denies local-tool ${action} actions.` };
    }
    if (policy === "allow_all") {
      return { allowed: true };
    }
    if (policy === "allow_safe" && manifestIsSafe(tool.manifest)) {
      return { allowed: true };
    }

    const signature = stableRequestSignature(requestJson);
    const existing = stateStore.getLocalToolApprovals({ toolId: tool.id })
      .find((approval) =>
        approval.action === action
        && stableRequestSignature(approval.requestJson) === signature
      );
    if (existing?.status === "approved") {
      return { allowed: true, approval: existing };
    }
    if (existing?.status === "denied" && (!existing.expiresAt || existing.expiresAt > nowIso())) {
      return { allowed: false, denied: true, reason: existing.denialReason ?? existing.reason, approval: existing };
    }

    return {
      allowed: false,
      approval: this.requestApproval(tool, action, requestedBy, reason, requestJson),
      reason,
    };
  }

  private async installNpmTool(tool: LocalToolRecord): Promise<LocalToolRecord> {
    const manifest = tool.manifest;
    if (!manifest.packageName || !manifest.packageVersion) {
      throw new Error(`Tool ${tool.id} is missing packageName/packageVersion.`);
    }

    const installDir = ensureInstallScaffold(tool.id, manifest);
    const npmCheck = await runCommand("npm", ["--version"], 15_000);
    if (!npmCheck.ok) {
      throw new Error("npm is not available on this Steward host.");
    }

    const install = await runCommand(
      "npm",
      ["install", "--no-save", "--no-package-lock", `${manifest.packageName}@${manifest.packageVersion}`],
      180_000,
      installDir,
    );
    if (!install.ok) {
      throw new Error(install.stderr || install.stdout || `Failed to install ${manifest.packageName}.`);
    }

    const binPaths = manifest.bins.reduce<Record<string, string>>((acc, bin) => {
      const candidate = path.join(
        installDir,
        "node_modules",
        ".bin",
        process.platform === "win32" ? `${bin.bin}.cmd` : bin.bin,
      );
      if (existsSync(candidate)) {
        acc[bin.name] = candidate;
      }
      return acc;
    }, {});

    return stateStore.upsertLocalTool({
      ...tool,
      status: "installed",
      healthStatus: "unknown",
      installDir,
      binPaths,
      installedVersion: packageVersionFromDisk(installDir, manifest) ?? manifest.packageVersion,
      lastInstalledAt: nowIso(),
      error: undefined,
      updatedAt: nowIso(),
    });
  }

  private async installBinaryPathTool(tool: LocalToolRecord): Promise<LocalToolRecord> {
    const binaryPath = tool.manifest.binaryPath?.trim();
    if (!binaryPath) {
      throw new Error(`Tool ${tool.id} does not declare a binaryPath.`);
    }
    if (!existsSync(binaryPath)) {
      throw new Error(`Configured binary path does not exist: ${binaryPath}`);
    }

    const binName = tool.manifest.bins[0]?.name ?? path.basename(binaryPath);
    return stateStore.upsertLocalTool({
      ...tool,
      status: "installed",
      healthStatus: "unknown",
      binPaths: { [binName]: binaryPath },
      installedVersion: tool.installedVersion,
      lastInstalledAt: nowIso(),
      error: undefined,
      updatedAt: nowIso(),
    });
  }

  async installTool(toolId: string, actor: "steward" | "user" = "steward"): Promise<LocalToolActionResult> {
    await this.initialize();
    const tool = stateStore.getLocalToolById(toolId);
    if (!tool) {
      return { ok: false, status: "failed", summary: `Local tool ${toolId} not found.`, error: "not_found" };
    }

    const approval = this.evaluateApproval(
      tool,
      "install",
      { toolId, packageVersion: tool.manifest.packageVersion ?? null },
      `Install local tool ${tool.manifest.name}`,
      actor,
    );
    if (!approval.allowed) {
      return {
        ok: false,
        status: approval.denied ? "failed" : "blocked",
        tool,
        approval: approval.approval,
        summary: approval.denied
          ? approval.reason ?? `Install denied for ${tool.manifest.name}.`
          : `Install for ${tool.manifest.name} is awaiting approval.`,
        error: approval.reason,
      };
    }

    stateStore.upsertLocalTool({
      ...tool,
      status: "installing",
      error: undefined,
      updatedAt: nowIso(),
    });

    try {
      const installed = tool.manifest.sourceKind === "npm-package"
        ? await this.installNpmTool(tool)
        : await this.installBinaryPathTool(tool);
      const health = await this.checkHealth(toolId);
      void stateStore.addAction({
        actor,
        kind: "config",
        message: `Installed local tool ${tool.manifest.name}`,
        context: {
          toolId: tool.id,
          version: installed.installedVersion ?? null,
        },
      });
      return { ok: true, status: "succeeded", tool: health.tool, summary: health.summary };
    } catch (error) {
      const failed = stateStore.upsertLocalTool({
        ...tool,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: nowIso(),
      });
      return {
        ok: false,
        status: "failed",
        tool: failed,
        summary: `Failed to install ${tool.manifest.name}.`,
        error: failed.error,
      };
    }
  }

  async checkHealth(toolId: string): Promise<LocalToolHealthResult> {
    await this.initialize();
    const tool = stateStore.getLocalToolById(toolId);
    if (!tool) {
      throw new Error(`Local tool ${toolId} not found.`);
    }

    if (tool.status !== "installed") {
      const updated = stateStore.upsertLocalTool({
        ...tool,
        healthStatus: "unavailable",
        lastCheckedAt: nowIso(),
        updatedAt: nowIso(),
      });
      return {
        ok: false,
        tool: updated,
        summary: `${tool.manifest.name} is not installed.`,
      };
    }

    let ok = true;
    let summary = `${tool.manifest.name} is healthy.`;
    const nextBinPaths = { ...tool.binPaths };
    for (const bin of tool.manifest.bins) {
      const binPath = resolveBinaryPath(tool, bin.name)
        ?? resolveBinaryPath(tool, bin.bin);
      if (!binPath || !existsSync(binPath)) {
        ok = false;
        summary = `Missing managed binary for ${bin.name}.`;
        break;
      }
      nextBinPaths[bin.name] = binPath;
      const healthArgs = bin.healthCheckArgs ?? [];
      if (healthArgs.length > 0) {
        const result = await runCommand(binPath, healthArgs, 20_000);
        if (!result.ok && result.code !== 0 && result.stdout.length === 0) {
          ok = false;
          summary = result.stderr || result.stdout || `Health check failed for ${bin.name}.`;
          break;
        }
      }
    }

    const updated = stateStore.upsertLocalTool({
      ...tool,
      binPaths: nextBinPaths,
      healthStatus: ok ? "healthy" : "degraded",
      lastCheckedAt: nowIso(),
      error: ok ? undefined : summary,
      updatedAt: nowIso(),
    });
    return { ok, tool: updated, summary };
  }

  async execute(
    request: LocalToolExecutionRequest,
    actor: "steward" | "user" = "steward",
  ): Promise<LocalToolExecutionResult | LocalToolActionResult> {
    await this.initialize();
    const tool = stateStore.getLocalToolById(request.toolId);
    if (!tool) {
      return { ok: false, status: "failed", summary: `Local tool ${request.toolId} not found.`, error: "not_found" };
    }

    if (tool.status !== "installed") {
      if (request.installIfMissing) {
        const install = await this.installTool(tool.id, actor);
        if (!install.ok) {
          return install;
        }
      } else {
        return {
          ok: false,
          status: "blocked",
          tool,
          summary: `${tool.manifest.name} is not installed.`,
          error: "not_installed",
        };
      }
    }

    const fresh = stateStore.getLocalToolById(request.toolId) ?? tool;
    if (request.healthCheckBeforeRun) {
      const health = await this.checkHealth(fresh.id);
      if (!health.ok) {
        return {
          ok: false,
          status: "failed",
          tool: health.tool,
          summary: health.summary,
          error: health.summary,
        };
      }
    }

    const approval = this.evaluateApproval(
      fresh,
      "execute",
      {
        toolId: request.toolId,
        command: request.command,
        argv: request.argv ?? [],
      },
      request.approvalReason ?? `Execute ${request.command} via ${fresh.manifest.name}`,
      actor,
    );
    if (!approval.allowed) {
      return {
        ok: false,
        status: approval.denied ? "failed" : "blocked",
        tool: fresh,
        approval: approval.approval,
        summary: approval.denied
          ? approval.reason ?? `Execution denied for ${fresh.manifest.name}.`
          : `Execution for ${fresh.manifest.name} is awaiting approval.`,
        error: approval.reason,
      };
    }

    const binPath = resolveBinaryPath(fresh, request.command);
    if (!binPath) {
      return {
        ok: false,
        status: "failed",
        tool: fresh,
        summary: `Managed command ${request.command} is not available for ${fresh.manifest.name}.`,
        error: "command_not_managed",
      };
    }

    const startedAt = Date.now();
    const result = await runCommand(binPath, request.argv ?? [], request.timeoutMs ?? 60_000, request.cwd);
    const durationMs = Date.now() - startedAt;
    stateStore.upsertLocalTool({
      ...fresh,
      lastRunAt: nowIso(),
      updatedAt: nowIso(),
      error: result.ok ? undefined : result.stderr || result.stdout,
    });
    void stateStore.addAction({
      actor,
      kind: "diagnose",
      message: `Executed local tool ${fresh.manifest.name}:${request.command}`,
      context: {
        toolId: fresh.id,
        command: request.command,
        argv: request.argv ?? [],
        code: result.code,
      },
    });

    return {
      ok: result.ok,
      toolId: fresh.id,
      command: request.command,
      argv: request.argv ?? [],
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: result.ok
        ? `${fresh.manifest.name}:${request.command} completed successfully.`
        : `${fresh.manifest.name}:${request.command} failed with exit code ${result.code}.`,
      binPath,
      durationMs,
    };
  }

  approveApproval(id: string, approvedBy = "user"): LocalToolApproval | undefined {
    void this.initialize();
    const approval = stateStore.getLocalToolApprovalById(id);
    if (!approval || approval.status !== "pending") {
      return undefined;
    }
    const updated: LocalToolApproval = {
      ...approval,
      status: "approved",
      approvedBy,
      approvedAt: nowIso(),
      decisionJson: {
        ...approval.decisionJson,
        approvedBy,
      },
    };
    stateStore.upsertLocalToolApproval(updated);
    const tool = stateStore.getLocalToolById(approval.toolId);
    if (tool) {
      stateStore.upsertLocalTool({
        ...tool,
        approvedAt: updated.approvedAt,
        updatedAt: nowIso(),
      });
    }
    return updated;
  }

  denyApproval(id: string, deniedBy = "user", reason = ""): LocalToolApproval | undefined {
    void this.initialize();
    const approval = stateStore.getLocalToolApprovalById(id);
    if (!approval || approval.status !== "pending") {
      return undefined;
    }
    const updated: LocalToolApproval = {
      ...approval,
      status: "denied",
      deniedBy,
      deniedAt: nowIso(),
      denialReason: reason,
      decisionJson: {
        ...approval.decisionJson,
        deniedBy,
        reason,
      },
    };
    stateStore.upsertLocalToolApproval(updated);
    return updated;
  }

  expireStaleApprovals(): number {
    void this.initialize();
    const now = Date.now();
    let expired = 0;
    for (const approval of stateStore.getPendingLocalToolApprovals()) {
      if (!approval.expiresAt) {
        continue;
      }
      if (new Date(approval.expiresAt).getTime() >= now) {
        continue;
      }
      stateStore.upsertLocalToolApproval({
        ...approval,
        status: "expired",
        deniedAt: nowIso(),
        denialReason: "Approval TTL expired",
        decisionJson: {
          ...approval.decisionJson,
          expiredAt: nowIso(),
        },
      });
      expired += 1;
    }
    return expired;
  }

  async runScheduledHealthChecks(): Promise<void> {
    await this.initialize();
    const runtime = stateStore.getRuntimeSettings();
    const now = Date.now();
    for (const tool of stateStore.getLocalTools()) {
      if (tool.status !== "installed") {
        continue;
      }
      if (tool.lastCheckedAt) {
        const lastChecked = new Date(tool.lastCheckedAt).getTime();
        if (Number.isFinite(lastChecked) && lastChecked + runtime.localToolHealthCheckIntervalMs > now) {
          continue;
        }
      }
      try {
        await this.checkHealth(tool.id);
      } catch {
        // Health failures are recorded on the tool row.
      }
    }
  }
}

export const localToolRuntime = new LocalToolRuntime();
