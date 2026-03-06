import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import {
  ensureOnboardingSession,
  getOnboardingSession,
} from "@/lib/adoption/conversation";
import { getDeviceAdoptionSnapshot } from "@/lib/adoption/orchestrator";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

async function buildPayload(deviceId: string, createIfMissing: boolean) {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    return { error: NextResponse.json({ error: "Device not found" }, { status: 404 }) };
  }

  const session = createIfMissing
    ? ensureOnboardingSession(device)
    : getOnboardingSession(device.id);

  const messages = session ? stateStore.getChatMessages(session.id) : [];
  const snapshot = await getDeviceAdoptionSnapshot(deviceId);

  return {
    payload: {
      session,
      messages,
      onboarding: {
        run: snapshot.run,
        unresolvedRequiredQuestions: snapshot.unresolvedRequiredQuestions,
        credentials: snapshot.credentials,
        accessSurfaces: snapshot.accessSurfaces,
        workloads: snapshot.workloads,
        assurances: snapshot.assurances,
        assuranceRuns: snapshot.assuranceRuns,
        bindings: snapshot.bindings,
        serviceContracts: snapshot.serviceContracts,
      },
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await buildPayload(id, false);
  if ("error" in result) {
    return result.error;
  }
  return NextResponse.json(result.payload);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await buildPayload(id, true);
  if ("error" in result) {
    return result.error;
  }
  return NextResponse.json(result.payload);
}
