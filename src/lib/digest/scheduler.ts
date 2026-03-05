import { generateDigest } from "@/lib/digest/generator";
import { stateStore } from "@/lib/state/store";
import type { SystemSettings } from "@/lib/state/types";

let digestHandle: NodeJS.Timeout | undefined;
let currentScheduleKey: string | undefined;

function datePartsAt(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
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

function localDateKey(date: Date, timeZone: string): string {
  const parts = datePartsAt(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function scheduleKey(settings: SystemSettings): string {
  return [
    settings.digestScheduleEnabled ? "1" : "0",
    settings.timezone,
    String(settings.digestHourLocal),
    String(settings.digestMinuteLocal),
  ].join(":");
}

function dueForToday(now: Date, settings: SystemSettings): boolean {
  const local = datePartsAt(now, settings.timezone);
  if (local.hour > settings.digestHourLocal) return true;
  if (local.hour < settings.digestHourLocal) return false;
  return local.minute >= settings.digestMinuteLocal;
}

async function maybeGenerateScheduledDigest(trigger: "startup" | "interval"): Promise<void> {
  const settings = stateStore.getSystemSettings();
  if (!settings.digestScheduleEnabled) {
    return;
  }

  const now = new Date();
  if (!dueForToday(now, settings)) {
    return;
  }

  const todayKey = localDateKey(now, settings.timezone);
  const latest = stateStore.getLatestDigest();
  if (latest && localDateKey(new Date(latest.generatedAt), settings.timezone) === todayKey) {
    return;
  }

  await generateDigest();
  await stateStore.addAction({
    actor: "steward",
    kind: "digest",
    message: `Scheduled digest generated (${todayKey} ${settings.timezone})`,
    context: {
      trigger,
      timezone: settings.timezone,
      schedule: {
        hour: settings.digestHourLocal,
        minute: settings.digestMinuteLocal,
      },
    },
  });
}

export function ensureDigestScheduler(): void {
  const settings = stateStore.getSystemSettings();
  const nextKey = scheduleKey(settings);

  if (digestHandle && currentScheduleKey === nextKey) {
    return;
  }

  if (digestHandle) {
    clearInterval(digestHandle);
    digestHandle = undefined;
  }

  currentScheduleKey = nextKey;
  digestHandle = setInterval(() => {
    void maybeGenerateScheduledDigest("interval").catch((error) => {
      console.error("Scheduled digest generation failed", error);
    });
  }, 60_000);

  void maybeGenerateScheduledDigest("startup").catch((error) => {
    console.error("Scheduled digest startup check failed", error);
  });
}

export function stopDigestScheduler(): void {
  if (!digestHandle) {
    return;
  }
  clearInterval(digestHandle);
  digestHandle = undefined;
  currentScheduleKey = undefined;
}
