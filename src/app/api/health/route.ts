import { NextResponse } from "next/server";
import { stateStore } from "@/lib/state/store";
import { vault } from "@/lib/security/vault";

export const runtime = "nodejs";

export async function GET() {
  const state = await stateStore.getState();

  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    version: state.version,
    devices: state.devices.length,
    openIncidents: state.incidents.filter((incident) => incident.status !== "resolved").length,
    vault: {
      ready: vault.isUnlocked() || await vault.ensureUnlocked(),
    },
  });
}
