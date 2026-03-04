import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const dismissSchema = z.object({
  id: z.string().min(1),
  dismissed: z.boolean(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = await stateStore.getState();
  return NextResponse.json({ recommendations: state.recommendations });
}

export async function PATCH(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = dismissSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  await stateStore.updateState(async (state) => {
    state.recommendations = state.recommendations.map((recommendation) => {
      if (recommendation.id !== payload.data.id) {
        return recommendation;
      }

      return {
        ...recommendation,
        dismissed: payload.data.dismissed,
      };
    });

    return state;
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Recommendation ${payload.data.id} dismissed=${payload.data.dismissed}`,
    context: {
      recommendationId: payload.data.id,
    },
  });

  return NextResponse.json({ ok: true });
}
