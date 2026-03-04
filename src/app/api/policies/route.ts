export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const CreatePolicySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  actionClasses: z.array(z.enum(["A", "B", "C", "D"])).optional(),
  autonomyTiers: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
  environmentLabels: z.array(z.enum(["prod", "staging", "dev", "lab"])).optional(),
  deviceTypes: z.array(z.enum(["server", "workstation", "router", "firewall", "switch", "access-point", "camera", "nas", "printer", "iot", "container-host", "hypervisor", "unknown"])).optional(),
  decision: z.enum(["ALLOW_AUTO", "REQUIRE_APPROVAL", "DENY"]),
  priority: z.number().int().min(0).optional().default(100),
  enabled: z.boolean().optional().default(true),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rules = stateStore.getPolicyRules();
  return NextResponse.json(rules);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = CreatePolicySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const now = new Date().toISOString();
  const rule = {
    id: randomUUID(),
    ...parsed.data,
    createdAt: now,
    updatedAt: now,
  };

  stateStore.upsertPolicyRule(rule);

  await stateStore.addAction({
    actor: "user",
    kind: "policy",
    message: `Created policy rule: ${rule.name}`,
    context: { ruleId: rule.id },
  });

  return NextResponse.json(rule, { status: 201 });
}
