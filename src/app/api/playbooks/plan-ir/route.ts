export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { parsePlanIr } from "@/lib/llm/plan-ir";
import { llmHealthController } from "@/lib/llm/health";
import { stateStore } from "@/lib/state/store";
import { evaluatePolicy } from "@/lib/policy/engine";
import { buildPlaybookRun, countRecentFamilyFailures, isFamilyQuarantined } from "@/lib/playbooks/factory";
import { createApproval } from "@/lib/approvals/queue";
import type { PlaybookDefinition } from "@/lib/state/types";

const BodySchema = z.object({
  deviceId: z.string().min(1),
  incidentId: z.string().optional(),
  provider: z.string().optional().default("default"),
  plan: z.unknown(),
});

function inferCriticality(plan: ReturnType<typeof parsePlanIr>): "low" | "medium" | "high" {
  const hasMutation = plan.steps.some((step) => step.operation.mode === "mutate");
  if (!hasMutation) return "low";
  const hasNetworkChange = plan.steps.some((step) => step.operation.kind === "network.config");
  return hasNetworkChange ? "high" : "medium";
}

function toPlaybookDefinition(plan: ReturnType<typeof parsePlanIr>): PlaybookDefinition {
  return {
    id: `planir:${plan.family}:${Date.now()}`,
    family: plan.family,
    name: `Plan IR remediation (${plan.family})`,
    description: plan.rationale,
    actionClass: inferCriticality(plan) === "high" ? "D" : "C",
    blastRadius: "single-device",
    timeoutMs: Math.max(...plan.steps.map((step) => step.operation.timeoutMs), 30_000),
    preconditions: {
      requiredProtocols: Array.from(new Set(plan.steps.map((step) => step.operation.adapterId))),
    },
    steps: plan.steps,
    verificationSteps: plan.verificationSteps,
    rollbackSteps: plan.rollbackSteps,
  };
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const runtimeSettings = stateStore.getRuntimeSettings();
  if (!runtimeSettings.laneBEnabled) {
    return NextResponse.json({ error: "Lane B is disabled" }, { status: 403 });
  }

  if (!llmHealthController.laneBAllowed(parsed.data.provider)) {
    return NextResponse.json({ error: "Lane B unavailable due to provider health" }, { status: 503 });
  }

  let plan;
  try {
    plan = parsePlanIr(parsed.data.plan);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid Plan IR" },
      { status: 400 },
    );
  }

  if (!runtimeSettings.laneBAllowedFamilies.includes(plan.family)) {
    return NextResponse.json(
      { error: `Lane B family not allowed: ${plan.family}` },
      { status: 403 },
    );
  }

  const state = await stateStore.getState();
  const device = state.devices.find((item) => item.id === parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  if (!runtimeSettings.laneBAllowedEnvironments.includes(device.environmentLabel ?? "lab")) {
    return NextResponse.json({ error: "Lane B disallowed for this environment" }, { status: 403 });
  }

  const synthesizedPlaybook = toPlaybookDefinition(plan);
  const recentFailures = countRecentFamilyFailures(device.id, synthesizedPlaybook.family);
  const quarantineActive = isFamilyQuarantined(device.id, synthesizedPlaybook.family);

  const policyEvaluation = evaluatePolicy(
    synthesizedPlaybook.actionClass,
    device,
    stateStore.getPolicyRules(),
    stateStore.getMaintenanceWindows(),
    {
      blastRadius: synthesizedPlaybook.blastRadius,
      criticality: inferCriticality(plan),
      lane: "B",
      recentFailures,
      quarantineActive,
    },
  );

  if (policyEvaluation.decision === "DENY") {
    return NextResponse.json(
      {
        error: "Policy denied Plan IR execution",
        policyEvaluation,
      },
      { status: 403 },
    );
  }

  const run = buildPlaybookRun(synthesizedPlaybook, {
    deviceId: device.id,
    incidentId: parsed.data.incidentId,
    policyEvaluation,
    initialStatus: policyEvaluation.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
    lane: "B",
  });

  if (policyEvaluation.decision === "REQUIRE_APPROVAL") {
    createApproval(run, device);
  } else {
    stateStore.upsertPlaybookRun(run);
  }

  await stateStore.addAction({
    actor: "steward",
    kind: "playbook",
    message: `Lane B Plan IR compiled for ${device.name} (${plan.family})`,
    context: {
      lane: "B",
      playbookRunId: run.id,
      policyDecision: policyEvaluation.decision,
      provider: parsed.data.provider,
    },
  });

  return NextResponse.json({ run, policyEvaluation }, { status: 201 });
}
