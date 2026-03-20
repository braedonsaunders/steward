import { NextResponse, type NextRequest } from "next/server";
import { expireStale } from "@/lib/approvals/queue";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  expireStale();
  const state = await stateStore.getState();
  const controlPlane = stateStore.getControlPlaneHealth();

  return NextResponse.json({
    ...state,
    controlPlane,
    actions: state.actions.slice(0, 200),
  });
}
