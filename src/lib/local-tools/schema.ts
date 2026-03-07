import { z } from "zod";

export const localToolBinarySchema = z.object({
  name: z.string().trim().min(1).max(120),
  bin: z.string().trim().min(1).max(240),
  versionArgs: z.array(z.string().min(1)).max(12).optional(),
  healthCheckArgs: z.array(z.string().min(1)).max(12).optional(),
});

export const localToolManifestSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2_000),
  sourceKind: z.enum(["npm-package", "binary-path"]),
  risk: z.enum(["low", "medium", "high"]),
  packageName: z.string().trim().min(1).max(240).optional(),
  packageVersion: z.string().trim().min(1).max(120).optional(),
  binaryPath: z.string().trim().min(1).max(2_000).optional(),
  docsUrl: z.string().url().optional(),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(64),
  bins: z.array(localToolBinarySchema).min(1).max(32),
  runtimeHints: z.object({
    interactive: z.boolean().optional(),
    requiresNetwork: z.boolean().optional(),
    singleConnectionRisk: z.boolean().optional(),
    vendor: z.string().trim().min(1).max(160).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.sourceKind === "npm-package") {
    if (!value.packageName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "packageName is required for npm-package tools", path: ["packageName"] });
    }
    if (!value.packageVersion) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "packageVersion is required for npm-package tools", path: ["packageVersion"] });
    }
  }
  if (value.sourceKind === "binary-path" && !value.binaryPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "binaryPath is required for binary-path tools", path: ["binaryPath"] });
  }
});

export const localToolExecuteSchema = z.object({
  command: z.string().trim().min(1).max(240),
  argv: z.array(z.string()).max(256).optional(),
  timeoutMs: z.number().int().min(1_000).max(15 * 60 * 1000).optional(),
  installIfMissing: z.boolean().optional(),
  healthCheckBeforeRun: z.boolean().optional(),
  approvalReason: z.string().trim().min(1).max(2_000).optional(),
});

export const localToolActionSchema = z.object({
  action: z.enum(["install", "health-check"]),
});

export const localToolApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  reason: z.string().trim().max(2_000).optional(),
});
