import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import {
  ensureOnboardingSession,
  getOnboardingSession,
} from "@/lib/adoption/conversation";
import { getDeviceAdoptionSnapshot } from "@/lib/adoption/orchestrator";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

function isBrokenSeedMessage(message: { content: string; error?: boolean }): boolean {
  if (/<tool_call>/i.test(message.content)) {
    return true;
  }

  if (!message.error) {
    return false;
  }

  const normalized = message.content.trim();
  return /^error$/i.test(normalized)
    || /^failed to process error response$/i.test(normalized)
    || /^[a-z0-9_]+_error$/i.test(normalized);
}

async function buildPayload(deviceId: string, createIfMissing: boolean) {
  const device = stateStore.getDeviceById(deviceId);
  if (!device) {
    return { error: NextResponse.json({ error: "Device not found" }, { status: 404 }) };
  }

  let session = createIfMissing
    ? ensureOnboardingSession(device)
    : getOnboardingSession(device.id);

  const existingMessages = session ? stateStore.getChatMessages(session.id) : [];
  const hasBrokenSeedSession = existingMessages.length === 1
    && existingMessages[0]?.role === "assistant"
    && isBrokenSeedMessage(existingMessages[0]);
  if (session && hasBrokenSeedSession) {
    stateStore.deleteChatSession(session.id);
    session = createIfMissing
      ? ensureOnboardingSession(device)
      : getOnboardingSession(device.id);
  }

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
        accessMethods: snapshot.accessMethods,
        profiles: snapshot.profiles,
        draft: snapshot.draft,
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
