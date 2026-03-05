import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/guard";
import { createLocalUser, listAuthUsers } from "@/lib/auth/identity";
import { hashPassword } from "@/lib/auth/password";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const CreateUserSchema = z.object({
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["Owner", "Admin", "Operator", "Auditor", "ReadOnly"]),
  password: z.string().min(12).max(256),
});

export async function GET(request: NextRequest) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }
  return NextResponse.json({ users: listAuthUsers() });
}

export async function POST(request: NextRequest) {
  const auth = getAuthContext(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: "Unauthorized", reason: auth.reason }, { status: auth.status });
  }

  const payload = CreateUserSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  let created;
  try {
    created = createLocalUser({
      username: payload.data.username,
      displayName: payload.data.displayName,
      role: payload.data.role,
      passwordHash: hashPassword(payload.data.password),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create user." },
      { status: 400 },
    );
  }

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Created local user",
    context: {
      username: created.username,
      role: created.role,
      actorUserId: auth.user?.id ?? null,
    },
  });

  return NextResponse.json({ ok: true, user: created }, { status: 201 });
}

