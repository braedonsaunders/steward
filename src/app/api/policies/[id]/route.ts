export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

const UpdatePolicySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  actionClasses: z.array(z.enum(["A", "B", "C", "D"])).optional(),
  autonomyTiers: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
  environmentLabels: z.array(z.enum(["prod", "staging", "dev", "lab"])).optional(),
  deviceTypes: z.array(z.enum(["server", "workstation", "router", "firewall", "switch", "access-point", "camera", "nas", "printer", "iot", "container-host", "hypervisor", "unknown"])).optional(),
  decision: z.enum(["ALLOW_AUTO", "REQUIRE_APPROVAL", "DENY"]).optional(),
  priority: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rules = stateStore.getPolicyRules();
  const rule = rules.find((r) => r.id === id);

  if (!rule) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(rule);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const rules = stateStore.getPolicyRules();
  const existing = rules.find((r) => r.id === id);

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const parsed = UpdatePolicySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const updated = {
    ...existing,
    ...parsed.data,
    updatedAt: new Date().toISOString(),
  };

  stateStore.upsertPolicyRule(updated);

  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  stateStore.deletePolicyRule(id);

  await stateStore.addAction({
    actor: "user",
    kind: "policy",
    message: `Deleted policy rule: ${id}`,
    context: { ruleId: id },
  });

  return NextResponse.json({ ok: true });
}
