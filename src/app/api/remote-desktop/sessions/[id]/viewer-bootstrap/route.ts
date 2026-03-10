import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { remoteDesktopManager } from "@/lib/remote-desktop/manager";

export const runtime = "nodejs";

const schema = z.object({
  viewerToken: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const bootstrap = await remoteDesktopManager.resolveViewerBootstrap({
      sessionId: id,
      viewerToken: parsed.data.viewerToken,
      hostHeader: request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "127.0.0.1:3010",
      requestProtocol: request.headers.get("x-forwarded-proto") ?? "http",
    });

    return NextResponse.json({
      ok: true,
      bootstrap,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to prepare embedded remote desktop viewer." },
      { status: 400 },
    );
  }
}
