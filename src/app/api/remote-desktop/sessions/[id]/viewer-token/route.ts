import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { remoteDesktopManager, RemoteDesktopConflictError } from "@/lib/remote-desktop/manager";

export const runtime = "nodejs";

const schema = z.object({
  holder: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  mode: z.enum(["observe", "command"]).optional(),
  exclusive: z.boolean().optional(),
  leaseTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
  viewerTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const session = remoteDesktopManager.getSession(id);
  if (!session) {
    return NextResponse.json({ error: "Remote desktop session not found" }, { status: 404 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const access = await remoteDesktopManager.createViewerAccess(id, {
      holder: parsed.data.holder ?? `api:${session.deviceId}`,
      purpose: parsed.data.purpose ?? `Remote desktop viewer for ${session.summary ?? session.id}`,
      mode: parsed.data.mode ?? "observe",
      exclusive: parsed.data.exclusive,
      leaseTtlMs: parsed.data.leaseTtlMs,
      viewerTtlMs: parsed.data.viewerTtlMs,
    });

    return NextResponse.json({
      ok: true,
      session: access.session,
      lease: access.lease,
      viewerToken: access.viewerToken,
      viewerPath: access.viewerPath,
      viewerUrl: access.viewerPath,
      viewerTokenExpiresAt: access.viewerTokenExpiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to issue viewer token.";
    return NextResponse.json(
      { error: message },
      { status: error instanceof RemoteDesktopConflictError ? 409 : 400 },
    );
  }
}
