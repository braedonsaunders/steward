import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/guard";
import {
  deleteAuthUser,
  deleteSessionsByUserId,
  getAuthUserById,
  listAuthUsers,
  updateAuthUser,
} from "@/lib/auth/identity";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const UpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["Owner", "Admin", "Operator", "Auditor", "ReadOnly"]).optional(),
  disabled: z.boolean().optional(),
});

function ownerCount(): number {
  return listAuthUsers().filter((user) => user.role === "Owner" && !user.disabled).length;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const payload = UpdateSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const { id } = await params;
  const existing = getAuthUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const nextRole = payload.data.role ?? existing.role;
  const nextDisabled = payload.data.disabled ?? existing.disabled;
  if (existing.role === "Owner" && (nextRole !== "Owner" || nextDisabled)) {
    if (ownerCount() <= 1) {
      return NextResponse.json({ error: "Cannot remove or disable the last Owner." }, { status: 400 });
    }
  }

  const updated = updateAuthUser(id, payload.data);
  if (!updated) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (updated.disabled) {
    deleteSessionsByUserId(updated.id);
  }

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Updated user account",
    context: {
      targetUserId: updated.id,
      role: updated.role,
      disabled: updated.disabled,
      actorUserId: auth.user?.id ?? null,
    },
  });

  return NextResponse.json({ ok: true, user: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const { id } = await params;
  const existing = getAuthUserById(id);
  if (!existing) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (existing.role === "Owner" && ownerCount() <= 1) {
    return NextResponse.json({ error: "Cannot delete the last Owner." }, { status: 400 });
  }

  if (auth.user?.id === id) {
    return NextResponse.json({ error: "Cannot delete the currently authenticated account." }, { status: 400 });
  }

  deleteSessionsByUserId(id);
  const ok = deleteAuthUser(id);
  if (!ok) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Deleted user account",
    context: {
      targetUserId: id,
      actorUserId: auth.user?.id ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}

