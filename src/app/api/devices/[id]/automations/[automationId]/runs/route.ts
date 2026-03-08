import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";
import { runDeviceAutomation } from "@/lib/widgets/automations";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; automationId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, automationId } = await params;
  const automation = stateStore.getDeviceAutomationById(automationId);
  if (!automation || automation.deviceId !== id) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }

  return NextResponse.json({ runs: stateStore.getDeviceAutomationRuns(automationId, 25) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; automationId: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, automationId } = await params;
  const automation = stateStore.getDeviceAutomationById(automationId);
  if (!automation || automation.deviceId !== id) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }

  try {
    const result = await runDeviceAutomation({
      automationId,
      trigger: "manual",
    });
    const statusCode = result.run.status === "succeeded"
      ? 200
      : result.run.status === "requires-approval"
        ? 428
        : result.run.status === "blocked"
          ? 403
          : 409;
    return NextResponse.json(result, { status: statusCode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Automation run failed" },
      { status: 400 },
    );
  }
}
