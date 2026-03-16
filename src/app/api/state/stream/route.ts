import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/auth/guard";
import { ensureStewardLoop } from "@/lib/agent/loop";
import { expireStale } from "@/lib/approvals/queue";
import { stateStore } from "@/lib/state/store";

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

      const sendState = async () => {
        if (closed || pumping) {
          return;
        }
        pumping = true;
        try {
          expireStale();
          const state = await stateStore.getState();
          const controlPlane = stateStore.getControlPlaneHealth();
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({ ...state, controlPlane })}\n\n`));
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

      void sendState();
      const timer = setInterval(() => {
        void sendState();
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
