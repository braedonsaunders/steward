export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { handleTelegramWebhook } from "@/lib/autonomy/gateway";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ bindingId: string }> },
) {
  try {
    const { bindingId } = await params;
    const result = await handleTelegramWebhook(bindingId, request);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
