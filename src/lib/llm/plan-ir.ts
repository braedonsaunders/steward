import { z } from "zod";
import type { ExecutionLane, OperationSpec } from "@/lib/state/types";

const OperationSafetySchema = z.object({
  dryRunSupported: z.boolean(),
  dryRunCommandTemplate: z.string().optional(),
  requiresConfirmedRevert: z.boolean(),
  revertMechanism: z.enum(["commit-confirmed", "timed-rollback", "manual"]).optional(),
  riskTags: z.array(z.string()).optional(),
  criticality: z.enum(["low", "medium", "high"]).optional(),
});

const OperationSpecSchema = z.object({
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
  safety: OperationSafetySchema,
});

const PlanStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  operation: OperationSpecSchema,
});

const PlanIrSchema = z.object({
  lane: z.enum(["B"]),
  family: z.string().min(1),
  rationale: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  verificationSteps: z.array(PlanStepSchema).default([]),
  rollbackSteps: z.array(PlanStepSchema).default([]),
});

export interface LlmPlanIr {
  lane: Extract<ExecutionLane, "B">;
  family: string;
  rationale: string;
  steps: Array<{ id: string; label: string; operation: OperationSpec }>;
  verificationSteps: Array<{ id: string; label: string; operation: OperationSpec }>;
  rollbackSteps: Array<{ id: string; label: string; operation: OperationSpec }>;
}

export function parsePlanIr(input: unknown): LlmPlanIr {
  const parsed = PlanIrSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid Plan IR: ${parsed.error.message}`);
  }
  return parsed.data as LlmPlanIr;
}
