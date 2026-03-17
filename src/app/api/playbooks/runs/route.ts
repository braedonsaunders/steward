export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { getPlaybookById } from "@/lib/playbooks/registry";
import { evaluatePolicy } from "@/lib/policy/engine";
import { createApproval } from "@/lib/approvals/queue";
import { getMissingCredentialProtocolsForPlaybook } from "@/lib/adoption/playbook-credentials";
import {
  buildPlaybookRun,
  countRecentFamilyFailures,
  criticalityForActionClass,
  isFamilyQuarantined,
} from "@/lib/playbooks/factory";
import { queuePlaybookExecution } from "@/lib/playbooks/orchestrator";

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

  const missingCredentials = getMissingCredentialProtocolsForPlaybook(device, playbook);
  if (missingCredentials.length > 0) {
    return NextResponse.json(
      {
        error: `Missing stored credentials for protocols: ${missingCredentials.join(", ")}`,
        missingCredentials,
      },
      { status: 400 },
    );
  }

  const rules = stateStore.getPolicyRules();
  const windows = stateStore.getMaintenanceWindows();
  const lane = "A" as const;
  const recentFailures = countRecentFamilyFailures(device.id, playbook.family);
  const quarantineActive = isFamilyQuarantined(device.id, playbook.family);
  const policyResult = evaluatePolicy(playbook.actionClass, device, rules, windows, {
    blastRadius: playbook.blastRadius,
    criticality: criticalityForActionClass(playbook.actionClass),
    lane,
    recentFailures,
    quarantineActive,
  });

  if (policyResult.decision === "DENY") {
    return NextResponse.json(
      { error: "Policy denied this action", policyEvaluation: policyResult },
      { status: 403 },
    );
  }

  const run = buildPlaybookRun(playbook, {
    deviceId: device.id,
    incidentId: parsed.data.incidentId,
    policyEvaluation: policyResult,
    initialStatus: policyResult.decision === "ALLOW_AUTO" ? "approved" : "pending_approval",
    lane,
  });

  if (policyResult.decision === "REQUIRE_APPROVAL") {
    createApproval(run, device);
  } else {
    stateStore.upsertPlaybookRun(run);
    queuePlaybookExecution(run, "auto");
  }

  return NextResponse.json(run, { status: 201 });
}
