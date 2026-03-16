import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { ensureStewardLoop, isStewardCycleRunning, requestScannerCycle } from "@/lib/agent/loop";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureStewardLoop();

  if (isStewardCycleRunning()) {
    return NextResponse.json(
      { ok: false, error: "Scanner cycle already running. Wait for the current cycle to finish." },
      { status: 409 },
    );
  }

  requestScannerCycle("manual");

  return NextResponse.json({ ok: true, started: true });
}
