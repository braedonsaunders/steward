import type { Device } from "@/lib/state/types";

export function buildOnboardingKickoffPrompt(device: Pick<Device, "name" | "ip">): string {
  return [
    `Start onboarding for ${device.name} (${device.ip}).`,
    "Give a concise opening that:",
    "1) states what you will investigate,",
    "2) asks for missing workload context if needed,",
    "3) asks for credentials only when required and with reason.",
    "Use plain operations language.",
  ].join("\n");
}
