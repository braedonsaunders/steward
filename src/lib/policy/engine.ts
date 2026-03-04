import type {
  ActionClass,
  AutonomyTier,
  Device,
  EnvironmentLabel,
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

function matchesRule(rule: PolicyRule, actionClass: ActionClass, device: Device, inWindow: boolean): boolean {
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
): PolicyEvaluation {
  const now = new Date();
  const inWindow = isDeviceInMaintenanceWindow(device.id, windows, now);
  const envLabel: EnvironmentLabel = device.environmentLabel ?? "lab";

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (matchesRule(rule, actionClass, device, inWindow)) {
      // Special case: if a DENY rule applies but we're in a maintenance window,
      // downgrade to REQUIRE_APPROVAL instead of hard deny for Class C/D
      let decision: PolicyDecision = rule.decision;
      if (decision === "DENY" && inWindow && (actionClass === "C" || actionClass === "D")) {
        decision = "REQUIRE_APPROVAL";
      }

      return {
        decision,
        ruleId: rule.id,
        reason: `Matched rule "${rule.name}" (priority ${rule.priority})${inWindow ? " [maintenance window active]" : ""}`,
        evaluatedAt: now.toISOString(),
        inputs: {
          actionClass,
          autonomyTier: device.autonomyTier,
          environmentLabel: envLabel,
          inMaintenanceWindow: inWindow,
          deviceId: device.id,
        },
      };
    }
  }

  // Default fallback: require approval for anything not explicitly covered
  return {
    decision: "REQUIRE_APPROVAL",
    ruleId: null,
    reason: "No matching policy rule found; defaulting to REQUIRE_APPROVAL",
    evaluatedAt: now.toISOString(),
    inputs: {
      actionClass,
      autonomyTier: device.autonomyTier,
      environmentLabel: envLabel,
      inMaintenanceWindow: inWindow,
      deviceId: device.id,
    },
  };
}
