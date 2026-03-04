import type { Device, PlaybookRun, PlaybookStep } from "@/lib/state/types";
import { runShell } from "@/lib/utils/shell";
import { stateStore } from "@/lib/state/store";

/**
 * Interpolates template variables in a command string.
 * Supported: {{host}}, {{service}}, {{container}}, {{domain}}, {{source}}, {{destination}}
 */
function interpolate(command: string, device: Device, params: Record<string, string> = {}): string {
  let result = command;
  result = result.replace(/\{\{host\}\}/g, device.ip);
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

async function executeStep(
  step: PlaybookStep,
  device: Device,
  params: Record<string, string>,
): Promise<PlaybookStep> {
  const updated: PlaybookStep = { ...step, status: "running", startedAt: new Date().toISOString() };

  try {
    const command = interpolate(step.command, device, params);
    const result = await runShell(command, step.timeoutMs);

    updated.completedAt = new Date().toISOString();
    updated.output = result.stdout + (result.stderr ? `\n[stderr] ${result.stderr}` : "");

    if (result.ok) {
      updated.status = "passed";
    } else {
      updated.status = "failed";
      updated.output += `\n[exit code: ${result.code}]`;
    }
  } catch (error) {
    updated.completedAt = new Date().toISOString();
    updated.status = "failed";
    updated.output = error instanceof Error ? error.message : String(error);
  }

  return updated;
}

/**
 * Check if this device+family has been quarantined (3+ failures in 24h).
 */
async function shouldQuarantine(deviceId: string, family: string): Promise<boolean> {
  const recent = stateStore.getPlaybookRuns({ deviceId });
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const recentFailures = recent.filter(
    (r) =>
      r.family === family &&
      r.status === "failed" &&
      new Date(r.createdAt).getTime() > oneDayAgo,
  );

  return recentFailures.length >= 3;
}

/**
 * Execute a playbook run through its full lifecycle:
 * preflight → steps → verification → (rollback on failure)
 */
export async function executePlaybook(
  run: PlaybookRun,
  device: Device,
  params: Record<string, string> = {},
): Promise<PlaybookRun> {
  let current = { ...run };

  // Check quarantine
  if (await shouldQuarantine(device.id, current.family)) {
    current.status = "quarantined";
    current.completedAt = new Date().toISOString();
    current.evidence.logs.push(`Quarantined: 3+ failures for ${current.family} on ${device.name} in last 24h`);
    return current;
  }

  // Preflight
  current.status = "preflight";
  current.startedAt = new Date().toISOString();
  current.evidence.logs.push(`Starting playbook "${current.name}" on ${device.name} (${device.ip})`);

  // Execute main steps
  current.status = "executing";
  let allPassed = true;

  for (let i = 0; i < current.steps.length; i++) {
    const result = await executeStep(current.steps[i], device, params);
    current.steps[i] = result;
    current.evidence.logs.push(`Step "${result.label}": ${result.status}`);

    if (result.status === "failed") {
      allPassed = false;
      // Mark remaining steps as skipped
      for (let j = i + 1; j < current.steps.length; j++) {
        current.steps[j] = { ...current.steps[j], status: "skipped" };
      }
      break;
    }
  }

  if (allPassed) {
    // Verification
    current.status = "verifying";
    let verificationPassed = true;

    for (let i = 0; i < current.verificationSteps.length; i++) {
      const result = await executeStep(current.verificationSteps[i], device, params);
      current.verificationSteps[i] = result;
      current.evidence.logs.push(`Verification "${result.label}": ${result.status}`);

      if (result.status === "failed") {
        verificationPassed = false;
        break;
      }
    }

    if (verificationPassed) {
      current.status = "completed";
      current.completedAt = new Date().toISOString();
      current.evidence.logs.push("Playbook completed successfully");
      return current;
    }
  }

  // Rollback if we have rollback steps
  if (current.rollbackSteps.length > 0) {
    current.status = "rolling_back";
    current.evidence.logs.push("Initiating rollback...");

    for (let i = 0; i < current.rollbackSteps.length; i++) {
      const result = await executeStep(current.rollbackSteps[i], device, params);
      current.rollbackSteps[i] = result;
      current.evidence.logs.push(`Rollback "${result.label}": ${result.status}`);
    }
  }

  current.status = "failed";
  current.completedAt = new Date().toISOString();
  current.failureCount += 1;
  current.evidence.logs.push(`Playbook failed (failure count: ${current.failureCount})`);

  return current;
}
