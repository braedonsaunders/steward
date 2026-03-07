import type { Device } from "@/lib/state/types";

export type DeviceAdoptionStatus = "discovered" | "adopted" | "ignored";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const getAdoptionRecord = (device: Device): Record<string, unknown> => {
  const adoption = device.metadata.adoption;
  return isRecord(adoption) ? adoption : {};
};

export const getDeviceAdoptionStatus = (device: Device): DeviceAdoptionStatus => {
  const adoption = getAdoptionRecord(device);
  const status = adoption.status;
  if (status === "adopted" || status === "ignored") {
    return status;
  }
  return "discovered";
};

export const getDeviceAttachedChatBlockReason = (device: Device): string | null => {
  if (getDeviceAdoptionStatus(device) !== "adopted") {
    return "Adopt this device before using attached chat controls.";
  }

  const adoption = getAdoptionRecord(device);
  const runStatus = typeof adoption.runStatus === "string" ? adoption.runStatus.trim().toLowerCase() : "";
  if (runStatus !== "completed") {
    return `Finish onboarding for ${device.name} first so Steward has a committed responsibility contract, adapter selection, and access plan.`;
  }

  return null;
};
