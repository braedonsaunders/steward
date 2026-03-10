import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth/guard";
import { remoteDesktopManager, RemoteDesktopConflictError } from "@/lib/remote-desktop/manager";
import { stateStore } from "@/lib/state/store";

export const runtime = "nodejs";

const createSessionSchema = z.object({
  deviceId: z.string().min(1),
  protocol: z.enum(["rdp", "vnc"]).optional(),
  credentialId: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  width: z.number().int().min(640).max(4096).optional(),
  height: z.number().int().min(480).max(4096).optional(),
  dpi: z.number().int().min(72).max(300).optional(),
  holder: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  mode: z.enum(["observe", "command"]).optional(),
  exclusive: z.boolean().optional(),
  leaseTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
  viewerTtlMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1000).optional(),
});

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deviceId = request.nextUrl.searchParams.get("deviceId") ?? undefined;
  const protocol = request.nextUrl.searchParams.get("protocol");
  return NextResponse.json({
    sessions: remoteDesktopManager.listSessions({
      ...(deviceId ? { deviceId } : {}),
      ...(protocol === "rdp" || protocol === "vnc" ? { protocol } : {}),
    }),
  });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSessionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(parsed.data.deviceId);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  try {
    const access = await remoteDesktopManager.openSession({
      device,
      protocol: parsed.data.protocol,
      credentialId: parsed.data.credentialId,
      host: parsed.data.host,
      port: parsed.data.port,
      width: parsed.data.width,
      height: parsed.data.height,
      dpi: parsed.data.dpi,
      holder: parsed.data.holder ?? `api:${device.id}`,
      purpose: parsed.data.purpose ?? `Remote desktop session for ${device.name}`,
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
    const message = error instanceof Error ? error.message : "Failed to open remote desktop session.";
    return NextResponse.json(
      { error: message },
      { status: error instanceof RemoteDesktopConflictError ? 409 : 400 },
    );
  }
}
