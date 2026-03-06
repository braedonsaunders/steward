import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { getIncidentType } from "@/lib/incidents/utils";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const state = await stateStore.getState();
  const incident = state.incidents.find((item) => item.id === id);

  if (!incident) {
    return NextResponse.json({ error: "Incident not found" }, { status: 404 });
  }

  const incidentType = getIncidentType(incident);
  if (!incidentType) {
    return NextResponse.json(
      { error: "Incident type could not be determined for this incident." },
      { status: 400 },
    );
  }

  const runtimeSettings = stateStore.getRuntimeSettings();
  const currentIgnored = runtimeSettings.ignoredIncidentTypes ?? [];
  if (!currentIgnored.includes(incidentType)) {
    stateStore.setRuntimeSettings({
      ...runtimeSettings,
      ignoredIncidentTypes: [...currentIgnored, incidentType],
    });
  }

  let resolvedCount = 0;
  const nowIso = new Date().toISOString();
  await stateStore.updateState(async (current) => {
    current.incidents = current.incidents.map((item) => {
      if (getIncidentType(item) !== incidentType || item.status === "resolved") {
        return item;
      }

      resolvedCount += 1;
      return {
        ...item,
        status: "resolved",
        updatedAt: nowIso,
        timeline: [
          {
            at: nowIso,
            message: `Ignored future incidents of type ${incidentType}`,
          },
          ...item.timeline,
        ].slice(0, 40),
      };
    });

    return current;
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Ignored future incidents of type ${incidentType}`,
    context: {
      incidentId: id,
      incidentType,
      resolvedCount,
    },
  });

  return NextResponse.json({
    ok: true,
    incidentType,
    resolvedCount,
    ignoredIncidentTypes: stateStore.getRuntimeSettings().ignoredIncidentTypes,
  });
}
