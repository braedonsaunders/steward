import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { cancelActiveChatStream } from "@/lib/assistant/chat-stream-registry";

export const runtime = "nodejs";

const schema = z.object({
  sessionId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    canceled: cancelActiveChatStream(parsed.data.sessionId),
  });
}

