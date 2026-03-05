import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { hashApiToken } from "@/lib/auth/token";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const schema = z.object({
  token: z.string().trim().min(16).max(256).nullable(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const settings = stateStore.getAuthSettings();
  return NextResponse.json(settings);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const token = parsed.data.token;
  const hash = token ? hashApiToken(token) : null;
  stateStore.setApiTokenHash(hash, { actor: "user" });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: token ? "Updated API auth token" : "Cleared API auth token",
    context: {
      auth: {
        apiTokenEnabled: Boolean(token),
      },
    },
  });

  return NextResponse.json(stateStore.getAuthSettings());
}
