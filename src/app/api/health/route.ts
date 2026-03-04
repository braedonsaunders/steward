import { NextResponse } from "next/server";
import { ensureStewardLoop } from "@/lib/agent/loop";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";

export const runtime = "nodejs";

export async function GET() {
  ensureStewardLoop();
  const state = await stateStore.getState();

  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    version: state.version,
    devices: state.devices.length,
    openIncidents: state.incidents.filter((incident) => incident.status !== "resolved").length,
    vault: {
      initialized: await vault.isInitialized(),
      unlocked: vault.isUnlocked(),
    },
  });
}
