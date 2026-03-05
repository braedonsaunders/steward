import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const schema = z.object({
  nodeIdentity: z.string().trim().min(1).max(128),
  timezone: z.string().trim().min(1).max(128),
  digestScheduleEnabled: z.boolean(),
  digestHourLocal: z.number().int().min(0).max(23),
  digestMinuteLocal: z.number().int().min(0).max(59),
  upgradeChannel: z.enum(["stable", "preview"]),
});

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const asOf = request.nextUrl.searchParams.get("asOf") ?? undefined;
  if (asOf && Number.isNaN(Date.parse(asOf))) {
    return NextResponse.json({ error: "Invalid asOf timestamp" }, { status: 400 });
  }

  const settings = stateStore.getSystemSettings(asOf);
  return NextResponse.json({ settings, asOf: asOf ?? null });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  if (!isValidTimezone(data.timezone)) {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }

  stateStore.setSystemSettings(data, { actor: "user" });
  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: "Updated system settings",
    context: data,
  });

  return NextResponse.json({ ok: true, settings: stateStore.getSystemSettings() });
}
