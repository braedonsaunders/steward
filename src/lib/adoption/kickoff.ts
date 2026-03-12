import type { Device } from "@/lib/state/types";

export function buildOnboardingKickoffPrompt(device: Pick<Device, "name" | "ip">): string {
  return [
    `Start onboarding for ${device.name} (${device.ip}).`,
    "Give a concise opening that:",
    "1) states the first probe or evidence-gathering step you will take,",
    "2) investigates the live management surface before asking about workload or role unless that context changes the safe next step,",
    "3) asks for missing workload context only after the initial probe when it is still needed,",
    "4) asks for credentials only when required and with reason.",
    "Do not ask what the device does before you inspect the surface Steward can actually reach.",
    "Use plain operations language.",
  ].join("\n");
}
