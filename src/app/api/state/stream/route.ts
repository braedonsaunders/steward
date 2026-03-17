import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { ensureStewardLoop } from "@/lib/agent/loop";
import { expireStale } from "@/lib/approvals/queue";
import { stateStore } from "@/lib/state/store";
import type { StateStreamSection } from "@/lib/state/types";

export const runtime = "nodejs";

const STREAM_INTERVAL_MS = 1000;

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  ensureStewardLoop();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pumping = false;
      let lastRevisions: Partial<Record<StateStreamSection, string>> = {};
      let lastControlPlaneJson = "";

      const sendPatch = async (force = false) => {
        if (closed || pumping) {
          return;
        }
        pumping = true;
        try {
          expireStale();
          const patch = stateStore.getStateStreamPatch(lastRevisions);
          const nextControlPlaneJson = JSON.stringify(patch.controlPlane ?? null);
          const hasSections = Object.keys(patch.sections).length > 0;
          const controlPlaneChanged = force || nextControlPlaneJson !== lastControlPlaneJson;
          if (!hasSections && !controlPlaneChanged && !force) {
            return;
          }
          lastRevisions = { ...patch.revisions };
          lastControlPlaneJson = nextControlPlaneJson;
          controller.enqueue(encoder.encode(`event: patch\ndata: ${JSON.stringify(patch)}\n\n`));
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`,
            ),
          );
        } finally {
          pumping = false;
        }
      };

      void sendPatch(true);
      const timer = setInterval(() => {
        void sendPatch();
      }, STREAM_INTERVAL_MS);

      const onAbort = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(timer);
        controller.close();
      };

      request.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
