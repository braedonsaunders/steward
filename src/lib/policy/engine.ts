import type {
  ActionClass,
  Device,
  EnvironmentLabel,
  ExecutionLane,
  MaintenanceWindow,
  PolicyDecision,
  PolicyEvaluation,
  PolicyRule,
} from "@/lib/state/types";

/**
 * Simple cron-like check: parses "HH:MM" or "* * * * *" style cron and
 * determines whether the current time falls within [cronStart, cronStart + duration].
 * For v1 we support two formats:
 *   - "HH:MM" daily schedule (runs every day at that time)
 *   - Full 5-field cron (minute hour dom month dow) — we only evaluate hour+minute for now
 */
function isInMaintenanceWindow(window: MaintenanceWindow, now: Date = new Date()): boolean {
  if (!window.enabled) return false;

  let startHour: number;
  let startMinute: number;

  const simple = window.cronStart.match(/^(\d{1,2}):(\d{2})$/);
  if (simple) {
    startHour = Number(simple[1]);
    startMinute = Number(simple[2]);
  } else {
    const fields = window.cronStart.trim().split(/\s+/);
    if (fields.length < 2) return false;
    startMinute = fields[0] === "*" ? 0 : Number(fields[0]);
    startHour = fields[1] === "*" ? 0 : Number(fields[1]);
  }

  const windowStart = new Date(now);
  windowStart.setHours(startHour, startMinute, 0, 0);

  const windowEnd = new Date(windowStart.getTime() + window.durationMinutes * 60_000);

  return now >= windowStart && now <= windowEnd;
}

export function isDeviceInMaintenanceWindow(
  deviceId: string,
  windows: MaintenanceWindow[],
  now: Date = new Date(),
): boolean {
  return windows.some((w) => {
    const appliesToDevice = w.deviceIds.length === 0 || w.deviceIds.includes(deviceId);
    return appliesToDevice && isInMaintenanceWindow(w, now);
  });
}

interface PolicyContext {
  blastRadius?: "single-service" | "single-device" | "multi-device";
  criticality?: "low" | "medium" | "high";
  lane?: ExecutionLane;
  recentFailures?: number;
  quarantineActive?: boolean;
}

function scorePolicyRisk(
  actionClass: ActionClass,
  device: Device,
  inMaintenanceWindow: boolean,
  context: Required<PolicyContext>,
): { riskScore: number; riskFactors: string[] } {
  let score = 0;
  const factors: string[] = [];

  const add = (weight: number, factor: string): void => {
    score += weight;
    factors.push(factor);
  };

  switch (actionClass) {
    case "A":
      add(0.08, "class-a-read");
      break;
    case "B":
      add(0.24, "class-b-safe-remediation");
      break;
    case "C":
      add(0.52, "class-c-config-change");
      break;
    case "D":
      add(0.76, "class-d-high-impact");
      break;
  }

  const envLabel = device.environmentLabel ?? "lab";
  if (envLabel === "prod") add(0.16, "prod-environment");
  else if (envLabel === "staging") add(0.08, "staging-environment");
  else if (envLabel === "dev") add(0.03, "dev-environment");

  if (device.autonomyTier === 1) add(0.08, "low-autonomy-tier");
  else if (device.autonomyTier === 2) add(0.03, "guarded-autonomy-tier");

  if (context.blastRadius === "multi-device") add(0.16, "multi-device-blast-radius");
  else if (context.blastRadius === "single-device") add(0.06, "single-device-blast-radius");

  if (context.criticality === "high") add(0.14, "high-criticality");
  else if (context.criticality === "medium") add(0.06, "medium-criticality");

  if (!inMaintenanceWindow && (actionClass === "C" || actionClass === "D")) {
    add(0.12, "outside-maintenance-window");
  }

  if (context.recentFailures > 0) {
    add(Math.min(0.18, context.recentFailures * 0.06), "recent-failure-history");
  }

  if (context.lane === "B") add(0.04, "lane-b-execution");
  else if (context.lane === "C") add(0.08, "lane-c-execution");

  if (context.quarantineActive) add(0.2, "quarantine-active");

  return {
    riskScore: Math.max(0, Math.min(1, score)),
    riskFactors: factors,
  };
}

function buildPolicyEvaluation(
  decision: PolicyDecision,
  ruleId: string | null,
  reason: string,
  riskScore: number,
  riskFactors: string[],
  actionClass: ActionClass,
  device: Device,
  inMaintenanceWindow: boolean,
  context: Required<PolicyContext>,
  now: Date,
): PolicyEvaluation {
  return {
    decision,
    ruleId,
    reason,
    riskScore,
    riskFactors,
    evaluatedAt: now.toISOString(),
    inputs: {
      actionClass,
      autonomyTier: device.autonomyTier,
      environmentLabel: device.environmentLabel ?? "lab",
      inMaintenanceWindow,
      deviceId: device.id,
      blastRadius: context.blastRadius,
      criticality: context.criticality,
      lane: context.lane,
      recentFailures: context.recentFailures,
      quarantineActive: context.quarantineActive,
    },
  };
}

function matchesRule(rule: PolicyRule, actionClass: ActionClass, device: Device): boolean {
  if (!rule.enabled) return false;

  if (rule.actionClasses && rule.actionClasses.length > 0 && !rule.actionClasses.includes(actionClass)) {
    return false;
  }

  if (rule.autonomyTiers && rule.autonomyTiers.length > 0 && !rule.autonomyTiers.includes(device.autonomyTier)) {
    return false;
  }

  const envLabel = device.environmentLabel ?? "lab";
  if (rule.environmentLabels && rule.environmentLabels.length > 0 && !rule.environmentLabels.includes(envLabel)) {
    return false;
  }

  if (rule.deviceTypes && rule.deviceTypes.length > 0 && !rule.deviceTypes.includes(device.type)) {
    return false;
  }

  return true;
}

/**
 * Evaluates which policy decision applies for a given action on a device.
 * Rules are evaluated in priority order (lower number = higher priority).
 * First matching rule wins.
 */
export function evaluatePolicy(
  actionClass: ActionClass,
  device: Device,
  rules: PolicyRule[],
  windows: MaintenanceWindow[],
  context: PolicyContext = {},
): PolicyEvaluation {
  const now = new Date();
  const inWindow = isDeviceInMaintenanceWindow(device.id, windows, now);
  const envLabel: EnvironmentLabel = device.environmentLabel ?? "lab";
  const resolvedContext: Required<PolicyContext> = {
    blastRadius: context.blastRadius ?? "single-device",
    criticality: context.criticality ?? "medium",
    lane: context.lane ?? "A",
    recentFailures: Math.max(0, context.recentFailures ?? 0),
    quarantineActive: context.quarantineActive ?? false,
  };
  const { riskScore, riskFactors } = scorePolicyRisk(actionClass, device, inWindow, resolvedContext);

  if (resolvedContext.quarantineActive) {
    return buildPolicyEvaluation(
      "DENY",
      null,
      "Execution is quarantined due to repeated failures",
      riskScore,
      riskFactors,
      actionClass,
      device,
      inWindow,
      resolvedContext,
      now,
    );
  }

  if (resolvedContext.recentFailures >= 3) {
    return buildPolicyEvaluation(
      "REQUIRE_APPROVAL",
      null,
      "Recent failure threshold reached; manual approval required",
      riskScore,
      riskFactors,
      actionClass,
      device,
      inWindow,
      resolvedContext,
      now,
    );
  }

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (matchesRule(rule, actionClass, device)) {
      const baseReason = `Matched rule "${rule.name}" (priority ${rule.priority})${inWindow ? " [maintenance window active]" : ""}`;
      const decisionNotes: string[] = [];

      // Special case: if a DENY rule applies but we're in a maintenance window,
      // downgrade to REQUIRE_APPROVAL instead of hard deny for Class C/D
      let decision: PolicyDecision = rule.decision;
      if (decision === "DENY" && inWindow && (actionClass === "C" || actionClass === "D")) {
        decision = "REQUIRE_APPROVAL";
        decisionNotes.push("Maintenance window downgraded a deny rule to require approval for a Class C/D change.");
      }

      // Hard safety overrides for high-risk conditions.
      if (actionClass === "D" && envLabel === "prod" && !inWindow) {
        decision = "DENY";
        decisionNotes.push("Production Class D changes outside a maintenance window are always denied.");
      } else if (actionClass === "D" && resolvedContext.blastRadius === "multi-device") {
        decision = "REQUIRE_APPROVAL";
        decisionNotes.push("Multi-device Class D blast radius requires approval.");
      } else if (resolvedContext.criticality === "high" && (actionClass === "C" || actionClass === "D")) {
        decision = "REQUIRE_APPROVAL";
        decisionNotes.push("High-criticality Class C/D work requires approval.");
      }

      if (decision === "ALLOW_AUTO" && riskScore >= 0.7) {
        decision = "REQUIRE_APPROVAL";
        decisionNotes.push(`Risk score ${riskScore.toFixed(2)} exceeded the auto-allow threshold.`);
      }

      return buildPolicyEvaluation(
        decision,
        rule.id,
        decisionNotes.length > 0 ? `${baseReason} ${decisionNotes.join(" ")}` : baseReason,
        riskScore,
        riskFactors,
        actionClass,
        device,
        inWindow,
        resolvedContext,
        now,
      );
    }
  }

  // Default fallback: require approval for anything not explicitly covered
  return buildPolicyEvaluation(
    "REQUIRE_APPROVAL",
    null,
    "No matching policy rule found; defaulting to REQUIRE_APPROVAL",
    riskScore,
    riskFactors,
    actionClass,
    device,
    inWindow,
    resolvedContext,
    now,
  );
}
