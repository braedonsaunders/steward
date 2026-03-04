export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { getPlaybookById } from "@/lib/playbooks/registry";
import { evaluatePolicy } from "@/lib/policy/engine";
import { createApproval } from "@/lib/approvals/queue";
import type { PlaybookRun, PlaybookStep } from "@/lib/state/types";

const TriggerSchema = z.object({
  playbookId: z.string().min(1),
  deviceId: z.string().min(1),
  incidentId: z.string().optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const deviceId = url.searchParams.get("deviceId") ?? undefined;

  const runs = stateStore.getPlaybookRuns({ status, deviceId });
  return NextResponse.json(runs);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = TriggerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const playbook = getPlaybookById(parsed.data.playbookId);
  if (!playbook) {
    return NextResponse.json({ error: "Playbook not found" }, { status: 404 });
  }

  const state = await stateStore.getState();
  const device = state.devices.find((d) => d.id === parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  const rules = stateStore.getPolicyRules();
  const windows = stateStore.getMaintenanceWindows();
  const policyResult = evaluatePolicy(playbook.actionClass, device, rules, windows);

  if (policyResult.decision === "DENY") {
    return NextResponse.json(
      { error: "Policy denied this action", policyEvaluation: policyResult },
      { status: 403 },
    );
  }

  const toRunStep = (s: Omit<PlaybookStep, "status" | "output" | "startedAt" | "completedAt">): PlaybookStep => ({
    ...s,
    status: "pending",
  });

  const run: PlaybookRun = {
    id: randomUUID(),
    playbookId: playbook.id,
    family: playbook.family,
    name: playbook.name,
    deviceId: device.id,
    incidentId: parsed.data.incidentId,
    actionClass: playbook.actionClass,
    status: policyResult.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
    policyEvaluation: policyResult,
    steps: playbook.steps.map(toRunStep),
    verificationSteps: playbook.verificationSteps.map(toRunStep),
    rollbackSteps: playbook.rollbackSteps.map(toRunStep),
    evidence: { logs: [] },
    createdAt: new Date().toISOString(),
    failureCount: 0,
  };

  if (policyResult.decision === "REQUIRE_APPROVAL") {
    createApproval(run, device);
  } else {
    stateStore.upsertPlaybookRun(run);
  }

  return NextResponse.json(run, { status: 201 });
}
