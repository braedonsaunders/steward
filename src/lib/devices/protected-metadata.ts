import { getAdoptionRecord, getDeviceAdoptionStatus } from "@/lib/state/device-adoption";
import { stateStore } from "@/lib/state/store";
import type { Device } from "@/lib/state/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const mergeProtectedDeviceMetadata = (device: Device): Device => {
  const latest = stateStore.getDeviceById(device.id);
  if (!latest) {
    return device;
  }

  const latestAdoption = getAdoptionRecord(latest);
  const incomingAdoption = isRecord(device.metadata.adoption) ? device.metadata.adoption : {};
  const latestStatus = getDeviceAdoptionStatus(latest);
  const incomingStatus = typeof incomingAdoption.status === "string" ? incomingAdoption.status : undefined;
  const preserveStickyStatus = (latestStatus === "adopted" || latestStatus === "ignored")
    && (incomingStatus === undefined || incomingStatus === "discovered");

  return {
    ...device,
    metadata: {
      ...latest.metadata,
      ...device.metadata,
      adoption: {
        ...latestAdoption,
        ...incomingAdoption,
        ...(preserveStickyStatus ? { status: latestStatus } : {}),
      },
    },
  };
};
