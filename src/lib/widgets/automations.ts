import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stateStore } from "@/lib/state/store";
import type {
  DeviceAutomation,
  DeviceAutomationRun,
  DeviceAutomationRunStatus,
  DeviceWidgetControlResult,
} from "@/lib/state/types";
import { executeWidgetControl, getWidgetControl } from "@/lib/widgets/controls";

export const DeviceAutomationMutationSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
  enabled: z.boolean().optional(),
  scheduleKind: z.enum(["manual", "interval", "daily"]),
  intervalMinutes: z.number().int().min(1).max(10_080).optional(),
  hourLocal: z.number().int().min(0).max(23).optional(),
  minuteLocal: z.number().int().min(0).max(59).optional(),
  inputJson: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, ctx) => {
  if (value.scheduleKind === "interval" && typeof value.intervalMinutes !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["intervalMinutes"],
      message: "intervalMinutes is required for interval automations.",
    });
  }
  if (value.scheduleKind === "daily") {
    if (typeof value.hourLocal !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hourLocal"],
        message: "hourLocal is required for daily automations.",
      });
    }
    if (typeof value.minuteLocal !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minuteLocal"],
        message: "minuteLocal is required for daily automations.",
      });
    }
  }
});

export function automationTargetWidgetId(automation: DeviceAutomation): string {
  return typeof automation.targetJson.widgetId === "string" && automation.targetJson.widgetId.trim().length > 0
    ? automation.targetJson.widgetId
    : automation.widgetId;
}

export function automationTargetControlId(automation: DeviceAutomation): string {
  return typeof automation.targetJson.controlId === "string" && automation.targetJson.controlId.trim().length > 0
    ? automation.targetJson.controlId
    : automation.controlId;
}

function datePartsAt(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year") ?? "1970"),
    month: Number(byType.get("month") ?? "1"),
    day: Number(byType.get("day") ?? "1"),
    hour: Number(byType.get("hour") ?? "0"),
    minute: Number(byType.get("minute") ?? "0"),
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = datePartsAt(candidate, timeZone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    candidate = new Date(candidate.getTime() + (wanted - actual));
  }
  return candidate;
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  increment: number,
): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  next.setUTCDate(next.getUTCDate() + increment);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

export function computeAutomationNextRunAt(
  automation: Pick<DeviceAutomation, "createdAt" | "enabled" | "scheduleKind" | "intervalMinutes" | "hourLocal" | "minuteLocal" | "lastRunAt">,
  now: Date = new Date(),
): string | undefined {
  if (!automation.enabled || automation.scheduleKind === "manual") {
    return undefined;
  }

  if (automation.scheduleKind === "interval") {
    const intervalMinutes = Math.max(1, automation.intervalMinutes ?? 0);
    const intervalMs = intervalMinutes * 60_000;
    const baseAt = new Date(automation.lastRunAt ?? automation.createdAt);
    let nextAt = new Date(baseAt.getTime() + intervalMs);
    while (nextAt.getTime() <= now.getTime()) {
      nextAt = new Date(nextAt.getTime() + intervalMs);
    }
    return nextAt.toISOString();
  }

  const settings = stateStore.getSystemSettings();
  const localNow = datePartsAt(now, settings.timezone);
  let candidate = zonedDateTimeToUtc(
    localNow.year,
    localNow.month,
    localNow.day,
    automation.hourLocal ?? 0,
    automation.minuteLocal ?? 0,
    settings.timezone,
  );
  if (candidate.getTime() <= now.getTime()) {
    const nextLocal = addLocalDays(localNow.year, localNow.month, localNow.day, 1);
    candidate = zonedDateTimeToUtc(
      nextLocal.year,
      nextLocal.month,
      nextLocal.day,
      automation.hourLocal ?? 0,
      automation.minuteLocal ?? 0,
      settings.timezone,
    );
  }
  return candidate.toISOString();
}

function mapControlResultToAutomationStatus(result: DeviceWidgetControlResult): DeviceAutomationRunStatus {
  if (result.ok) {
    return "succeeded";
  }
  if (result.status === "requires-approval") {
    return "requires-approval";
  }
  if (result.status === "blocked") {
    return "blocked";
  }
  return "failed";
}

function recordAutomationAttempt(
  automation: DeviceAutomation,
  status: DeviceAutomationRunStatus,
  summary: string,
  resultJson: Record<string, unknown>,
): DeviceAutomation {
  const nowIso = new Date().toISOString();
  const updated: DeviceAutomation = {
    ...automation,
    lastRunAt: nowIso,
    nextRunAt: computeAutomationNextRunAt(
      {
        ...automation,
        lastRunAt: nowIso,
      },
      new Date(nowIso),
    ),
    lastRunStatus: status,
    lastRunSummary: summary,
    updatedAt: nowIso,
  };
  stateStore.upsertDeviceAutomation(updated);
  stateStore.addDeviceAutomationRun({
    id: `device-automation-run-${randomUUID()}`,
    automationId: automation.id,
    deviceId: automation.deviceId,
    widgetId: automation.widgetId,
    controlId: automation.controlId,
    status,
    summary,
    resultJson,
    createdAt: nowIso,
    completedAt: nowIso,
  });
  return updated;
}

export async function runDeviceAutomation(args: {
  automationId: string;
  trigger: "manual" | "scheduled";
}): Promise<{
  automation: DeviceAutomation;
  run: DeviceAutomationRun;
}> {
  const automation = stateStore.getDeviceAutomationById(args.automationId);
  if (!automation) {
    throw new Error("Automation not found.");
  }

  if (automation.targetKind !== "widget-control") {
    const updated = recordAutomationAttempt(
      automation,
      "skipped",
      `Automation target kind ${automation.targetKind} is not executable yet.`,
      {
        trigger: args.trigger,
        targetKind: automation.targetKind,
      },
    );
    const run = stateStore.getDeviceAutomationRuns(updated.id, 1)[0];
    return { automation: updated, run };
  }

  const targetWidgetId = automationTargetWidgetId(automation);
  const targetControlId = automationTargetControlId(automation);
  const device = stateStore.getDeviceById(automation.deviceId);
  const widget = stateStore.getDeviceWidgetById(targetWidgetId);
  const control = widget ? getWidgetControl(widget, targetControlId) : null;

  if (!device || !widget || !control || widget.deviceId !== device.id) {
    const updated = recordAutomationAttempt(
      automation,
      "failed",
      "Automation target is no longer available.",
      {
        trigger: args.trigger,
        deviceFound: Boolean(device),
        widgetFound: Boolean(widget),
        controlFound: Boolean(control),
      },
    );
    const run = stateStore.getDeviceAutomationRuns(updated.id, 1)[0];
    return { automation: updated, run };
  }

  let updated: DeviceAutomation;
  let run: DeviceAutomationRun;
  try {
    const result = await executeWidgetControl({
      device,
      widget,
      control,
      inputValues: automation.inputJson,
      approved: false,
      actor: "steward",
    });
    const status = mapControlResultToAutomationStatus(result);
    updated = recordAutomationAttempt(automation, status, result.summary, {
      trigger: args.trigger,
      controlResult: result,
    });
    run = stateStore.getDeviceAutomationRuns(updated.id, 1)[0];
    return { automation: updated, run };
  } catch (error) {
    updated = recordAutomationAttempt(
      automation,
      "failed",
      error instanceof Error ? error.message : "Automation execution failed.",
      {
        trigger: args.trigger,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    run = stateStore.getDeviceAutomationRuns(updated.id, 1)[0];
    return { automation: updated, run };
  }
}

let automationSchedulerHandle: NodeJS.Timeout | undefined;
let automationSweepRunning = false;

async function maybeRunDueAutomations(trigger: "startup" | "interval"): Promise<void> {
  if (automationSweepRunning) {
    return;
  }
  automationSweepRunning = true;
  try {
    const due = stateStore.getDueDeviceAutomations(new Date().toISOString(), 25);
    for (const automation of due) {
      try {
        await runDeviceAutomation({
          automationId: automation.id,
          trigger: "scheduled",
        });
      } catch (error) {
        console.error(`Device automation ${automation.id} failed during ${trigger} sweep`, error);
      }
    }
  } finally {
    automationSweepRunning = false;
  }
}

export function ensureDeviceAutomationScheduler(): void {
  if (automationSchedulerHandle) {
    return;
  }

  automationSchedulerHandle = setInterval(() => {
    void maybeRunDueAutomations("interval");
  }, 60_000);

  void maybeRunDueAutomations("startup");
}

export function stopDeviceAutomationScheduler(): void {
  if (!automationSchedulerHandle) {
    return;
  }
  clearInterval(automationSchedulerHandle);
  automationSchedulerHandle = undefined;
}
