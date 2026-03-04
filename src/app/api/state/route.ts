import { NextResponse, type NextRequest } from "next/server";
import { ensureStewardLoop } from "@/lib/agent/loop";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureStewardLoop();
  const state = await stateStore.getState();

  return NextResponse.json({
    ...state,
    actions: state.actions.slice(0, 200),
  });
}
