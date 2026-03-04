import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";

export const runtime = "nodejs";

const schema = z.object({
  action: z.enum(["init", "unlock", "lock"]),
  passphrase: z.string().min(4).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await vault.ensureUnlocked();

  return NextResponse.json({
    initialized: await vault.isInitialized(),
    unlocked: vault.isUnlocked(),
    keyCount: (await vault.listSecretKeys()).length,
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = schema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const { action, passphrase } = payload.data;

  if (action === "lock") {
    vault.lock();
    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: "Vault locked",
      context: {},
    });

    return NextResponse.json({ ok: true, unlocked: false });
  }

  if (!passphrase) {
    return NextResponse.json({ error: "Passphrase required" }, { status: 400 });
  }

  if (action === "init") {
    await vault.initialize(passphrase);
    await stateStore.addAction({
      actor: "user",
      kind: "auth",
      message: "Vault initialized",
      context: {},
    });

    return NextResponse.json({ ok: true, initialized: true, unlocked: true });
  }

  const unlocked = await vault.unlock(passphrase);
  if (!unlocked) {
    return NextResponse.json({ ok: false, error: "Invalid passphrase" }, { status: 401 });
  }

  await stateStore.addAction({
    actor: "user",
    kind: "auth",
    message: "Vault unlocked",
    context: {},
  });

  return NextResponse.json({ ok: true, unlocked: true });
}
