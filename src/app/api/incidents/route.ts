import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const updateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["open", "in_progress", "resolved"]),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = await stateStore.getState();
  return NextResponse.json({ incidents: state.incidents });
}

export async function PATCH(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = updateSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  await stateStore.updateState(async (state) => {
    state.incidents = state.incidents.map((incident) => {
      if (incident.id !== payload.data.id) {
        return incident;
      }

      return {
        ...incident,
        status: payload.data.status,
        updatedAt: new Date().toISOString(),
        timeline: [
          {
            at: new Date().toISOString(),
            message: `Status updated to ${payload.data.status}`,
          },
          ...incident.timeline,
        ].slice(0, 40),
      };
    });

    return state;
  });

  await stateStore.addAction({
    actor: "user",
    kind: "remediate",
    message: `Incident ${payload.data.id} marked ${payload.data.status}`,
    context: {
      incidentId: payload.data.id,
    },
  });

  return NextResponse.json({ ok: true });
}
