import type { Device, EnvironmentLabel, ExecutionLane, RuntimeSettings } from "@/lib/state/types";

export interface LaneContext {
  lane: ExecutionLane;
  environment: EnvironmentLabel;
  isMutation: boolean;
}

export function resolveLaneEnvironment(device: Device): EnvironmentLabel {
  return device.environmentLabel ?? "lab";
}

export function isLaneAllowed(ctx: LaneContext, settings: RuntimeSettings): { allowed: boolean; reason: string } {
  if (ctx.lane === "A") {
    return { allowed: true, reason: "Lane A deterministic operations are enabled" };
  }

  if (ctx.lane === "B") {
    if (!settings.laneBEnabled) {
      return { allowed: false, reason: "Lane B is disabled" };
    }
    if (!settings.laneBAllowedEnvironments.includes(ctx.environment)) {
      return { allowed: false, reason: `Lane B disallowed in environment ${ctx.environment}` };
    }
    return { allowed: true, reason: "Lane B enabled for this environment" };
  }

  // Lane C (exploratory)
  if (!ctx.isMutation) {
    return { allowed: true, reason: "Lane C read-only operation allowed" };
  }

  if (ctx.environment === "prod" && !settings.laneCMutationsInProd) {
    return { allowed: false, reason: "Lane C mutations are disabled in production" };
  }

  if (ctx.environment === "lab" && !settings.laneCMutationsInLab) {
    return { allowed: false, reason: "Lane C mutations are disabled in lab" };
  }

  return { allowed: false, reason: "Lane C mutations require explicit stepped proxy mode" };
}
