import { headers } from "next/headers";
import { AlertTriangle } from "lucide-react";
import { RemoteDesktopViewer } from "@/components/remote-desktop-viewer";
import { remoteDesktopManager } from "@/lib/remote-desktop/manager";

export const runtime = "nodejs";

function renderError(message: string) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-2xl border border-rose-500/25 bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Remote desktop unavailable</h1>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}

export default async function RemoteDesktopPage(
  {
    params,
    searchParams,
  }: {
    params: Promise<{ sessionId: string }>;
    searchParams: Promise<{ viewerToken?: string }>;
  },
) {
  const { sessionId } = await params;
  const query = await searchParams;
  const viewerToken = typeof query.viewerToken === "string" ? query.viewerToken : "";

  if (!viewerToken) {
    return renderError("This remote desktop viewer requires a signed Steward viewer token.");
  }

  let bootstrap:
    | Awaited<ReturnType<typeof remoteDesktopManager.resolveViewerBootstrap>>
    | null = null;
  let errorMessage: string | null = null;

  try {
    const headerList = await headers();
    bootstrap = await remoteDesktopManager.resolveViewerBootstrap({
      sessionId,
      viewerToken,
      hostHeader: headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "127.0.0.1:3010",
      requestProtocol: headerList.get("x-forwarded-proto") ?? "http",
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Failed to load remote desktop viewer.";
  }

  if (!bootstrap) {
    return renderError(errorMessage ?? "Failed to load remote desktop viewer.");
  }

  return (
    <main className="flex min-h-screen flex-col bg-background p-3 sm:p-4">
      <RemoteDesktopViewer
        sessionId={bootstrap.session.id}
        leaseId={bootstrap.lease.id}
        deviceName={bootstrap.deviceName}
        protocol={bootstrap.protocol}
        controlMode={bootstrap.claims.mode}
        bridgeWsUrl={bootstrap.bridgeWsUrl}
        bridgeConnectQuery={bootstrap.bridgeConnectQuery}
        initialWidth={bootstrap.config.width}
        initialHeight={bootstrap.config.height}
      />
    </main>
  );
}
