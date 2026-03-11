import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { adapterRegistry } from "@/lib/adapters/registry";
import { isAuthorized } from "@/lib/auth/guard";
import {
  startDeviceAdoption,
  updateDeviceOnboardingDraft,
} from "@/lib/adoption/orchestrator";
import { stateStore } from "@/lib/state/store";
import type { AccessMethod, DeviceProfileBinding } from "@/lib/state/types";

export const runtime = "nodejs";

const profileUpdateSchema = z.object({
  profileId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["primary", "fallback", "supporting"]).optional(),
  summary: z.string().trim().max(400).optional(),
  requiredAccessMethods: z.array(z.string().trim().min(1)).optional(),
  requiredCredentialProtocols: z.array(z.string().trim().min(1)).optional(),
});

const bindSchema = z.object({
  profileId: z.string().trim().min(1).optional(),
  profileIds: z.array(z.string().trim().min(1)).optional(),
  accessMethodKeys: z.array(z.string().trim().min(1)).optional(),
  attachAdapterId: z.string().trim().min(1).optional(),
  removeProfileId: z.string().trim().min(1).optional(),
  updateProfile: profileUpdateSchema.optional(),
}).refine(
  (value) => Boolean(
    value.profileId
    || "profileIds" in value
    || "accessMethodKeys" in value
    || value.attachAdapterId
    || value.removeProfileId
    || value.updateProfile,
  ),
  "Provide at least one adapter binding change.",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedProfileIdsFromSnapshot(snapshot: Awaited<ReturnType<typeof startDeviceAdoption>>): string[] {
  if (snapshot.draft?.selectedProfileIds) {
    return snapshot.draft.selectedProfileIds;
  }
  return snapshot.profiles
    .filter((profile) => ["selected", "verified", "active"].includes(profile.status))
    .map((profile) => profile.profileId);
}

function selectedAccessMethodKeysFromSnapshot(snapshot: Awaited<ReturnType<typeof startDeviceAdoption>>): string[] {
  if (snapshot.draft?.selectedAccessMethodKeys) {
    return snapshot.draft.selectedAccessMethodKeys;
  }
  return snapshot.accessMethods
    .filter((method) => method.selected)
    .map((method) => method.key);
}

function preferredAccessKeyForKind(kind: string, accessMethods: AccessMethod[]): string | null {
  const requestedKinds = kind === "http-api"
    ? ["web-session", "http-api"]
    : kind === "web-session"
      ? ["web-session", "http-api"]
      : [kind];
  const statusRank = (status: AccessMethod["status"]): number => (
    status === "validated" ? 0
      : status === "credentialed" ? 1
        : status === "observed" ? 2
          : 3
  );

  return accessMethods
    .filter((method) => requestedKinds.includes(method.kind))
    .sort((left, right) => {
      if (left.selected !== right.selected) {
        return left.selected ? -1 : 1;
      }
      if (left.status !== right.status) {
        return statusRank(left.status) - statusRank(right.status);
      }
      if ((left.port !== undefined) !== (right.port !== undefined)) {
        return left.port !== undefined ? -1 : 1;
      }
      if ((left.port ?? 0) !== (right.port ?? 0)) {
        return (left.port ?? 0) - (right.port ?? 0);
      }
      if (left.secure !== right.secure) {
        return left.secure ? -1 : 1;
      }
      return left.key.localeCompare(right.key);
    })[0]?.key ?? null;
}

function deriveAccessMethodKeys(
  selectedProfileIds: string[],
  profiles: DeviceProfileBinding[],
  accessMethods: AccessMethod[],
  fallbackKeys: string[],
): string[] {
  const selectedProfiles = profiles.filter((profile) => selectedProfileIds.includes(profile.profileId));
  const requiredKinds = Array.from(new Set(selectedProfiles.flatMap((profile) => profile.requiredAccessMethods)));
  if (requiredKinds.length === 0) {
    const available = new Set(accessMethods.map((method) => method.key));
    return fallbackKeys.filter((key) => available.has(key));
  }

  return requiredKinds
    .map((kind) => preferredAccessKeyForKind(kind, accessMethods))
    .filter((key): key is string => Boolean(key));
}

function guessManualBindingRequirements(adapterId: string, accessMethods: AccessMethod[]): {
  requiredAccessMethods: string[];
  requiredCredentialProtocols: string[];
} {
  const normalized = adapterId.toLowerCase();
  const preferredKinds = normalized.includes("http") || normalized.includes("web")
    ? ["web-session", "http-api"]
    : normalized.includes("ssh") || normalized.includes("linux")
      ? ["ssh"]
      : normalized.includes("telnet")
        ? ["telnet"]
        : normalized.includes("winrm") || normalized.includes("windows")
          ? ["winrm", "powershell-ssh", "wmi", "smb"]
          : normalized.includes("snmp")
            ? ["snmp"]
            : normalized.includes("docker")
              ? ["docker"]
              : normalized.includes("kubernetes") || normalized.includes("k8s")
                ? ["kubernetes"]
                : normalized.includes("mqtt")
                  ? ["mqtt"]
                  : [];
  const requiredAccessMethods = preferredKinds.filter((kind) => accessMethods.some((method) => method.kind === kind));
  const requiredCredentialProtocols = requiredAccessMethods.map((kind) => kind === "web-session" ? "http-api" : kind);
  return {
    requiredAccessMethods,
    requiredCredentialProtocols,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const payload = bindSchema.safeParse(await request.json().catch(() => ({})));
  if (!payload.success) {
    return NextResponse.json({ error: payload.error.flatten() }, { status: 400 });
  }

  const device = stateStore.getDeviceById(id);
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  let snapshot = await startDeviceAdoption(id, { triggeredBy: "user" });
  let nextSelectedProfileIds = selectedProfileIdsFromSnapshot(snapshot);
  let nextSelectedAccessMethodKeys = selectedAccessMethodKeysFromSnapshot(snapshot);
  let changedManually = false;

  if (payload.data.attachAdapterId) {
    await adapterRegistry.initialize();
    const adapter = adapterRegistry.getAdapterRecordById(payload.data.attachAdapterId);
    if (!adapter) {
      return NextResponse.json({ error: `Unknown adapter: ${payload.data.attachAdapterId}` }, { status: 404 });
    }
    const existing = stateStore.getDeviceProfiles(id).find((profile) =>
      profile.adapterId === adapter.id
      && isRecord(profile.draftJson)
      && profile.draftJson.manualBinding === true,
    );
    const inferred = guessManualBindingRequirements(adapter.id, snapshot.accessMethods);
    const requiredAccessMethods = existing?.requiredAccessMethods ?? inferred.requiredAccessMethods;
    const requiredCredentialProtocols = existing?.requiredCredentialProtocols ?? inferred.requiredCredentialProtocols;
    const now = new Date().toISOString();
    stateStore.upsertDeviceProfile({
      id: existing?.id ?? randomUUID(),
      deviceId: id,
      profileId: existing?.profileId ?? `manual:${adapter.id}`,
      adapterId: adapter.id,
      name: existing?.name ?? adapter.name,
      kind: existing?.kind ?? "supporting",
      confidence: existing?.confidence ?? 0.35,
      status: "selected",
      summary: existing?.summary ?? `Manually attached adapter ${adapter.name}.`,
      requiredAccessMethods,
      requiredCredentialProtocols,
      evidenceJson: {
        ...(existing?.evidenceJson ?? {}),
        source: "manual-binding",
      },
      draftJson: {
        ...(existing?.draftJson ?? {}),
        manualBinding: true,
        manualName: existing?.name ?? adapter.name,
        manualKind: existing?.kind ?? "supporting",
        manualSummary: existing?.summary ?? `Manually attached adapter ${adapter.name}.`,
        manualRequiredAccessMethods: requiredAccessMethods,
        manualRequiredCredentialProtocols: requiredCredentialProtocols,
        manuallyRejected: false,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    changedManually = true;
  }

  if (payload.data.removeProfileId) {
    const existing = stateStore.getDeviceProfiles(id).find((profile) => profile.profileId === payload.data.removeProfileId);
    if (!existing) {
      return NextResponse.json({ error: `Unknown device adapter binding: ${payload.data.removeProfileId}` }, { status: 404 });
    }
    if (isRecord(existing.draftJson) && existing.draftJson.manualBinding === true) {
      stateStore.deleteDeviceProfile(id, existing.profileId);
    } else {
      stateStore.upsertDeviceProfile({
        ...existing,
        status: "rejected",
        draftJson: {
          ...(existing.draftJson ?? {}),
          manuallyRejected: true,
        },
        updatedAt: new Date().toISOString(),
      });
    }
    nextSelectedProfileIds = nextSelectedProfileIds.filter((profileId) => profileId !== payload.data.removeProfileId);
    changedManually = true;
  }

  if (payload.data.updateProfile) {
    const existing = stateStore.getDeviceProfiles(id).find((profile) => profile.profileId === payload.data.updateProfile?.profileId);
    if (!existing) {
      return NextResponse.json({ error: `Unknown device adapter binding: ${payload.data.updateProfile.profileId}` }, { status: 404 });
    }
    const draftJson = isRecord(existing.draftJson) ? existing.draftJson : {};
    const requiredAccessMethods = payload.data.updateProfile.requiredAccessMethods
      ? Array.from(new Set(payload.data.updateProfile.requiredAccessMethods.map((item) => item.trim()).filter(Boolean)))
      : existing.requiredAccessMethods;
    const requiredCredentialProtocols = payload.data.updateProfile.requiredCredentialProtocols
      ? Array.from(new Set(payload.data.updateProfile.requiredCredentialProtocols.map((item) => item.trim()).filter(Boolean)))
      : existing.requiredCredentialProtocols;
    stateStore.upsertDeviceProfile({
      ...existing,
      name: payload.data.updateProfile.name ?? existing.name,
      kind: payload.data.updateProfile.kind ?? existing.kind,
      summary: payload.data.updateProfile.summary ?? existing.summary,
      requiredAccessMethods,
      requiredCredentialProtocols,
      draftJson: {
        ...draftJson,
        manualBinding: draftJson.manualBinding === true,
        manualName: payload.data.updateProfile.name ?? draftJson.manualName ?? existing.name,
        manualKind: payload.data.updateProfile.kind ?? draftJson.manualKind ?? existing.kind,
        manualSummary: payload.data.updateProfile.summary ?? draftJson.manualSummary ?? existing.summary,
        manualRequiredAccessMethods: requiredAccessMethods,
        manualRequiredCredentialProtocols: requiredCredentialProtocols,
        manuallyRejected: false,
      },
      updatedAt: new Date().toISOString(),
    });
    changedManually = true;
  }

  if (changedManually) {
    snapshot = await startDeviceAdoption(id, { triggeredBy: "user" });
  }

  const explicitProfileIds = [
    ...(payload.data.profileIds ?? []),
    ...(payload.data.profileId ? [payload.data.profileId] : []),
  ];
  if (explicitProfileIds.length > 0 || "profileIds" in payload.data || payload.data.profileId) {
    nextSelectedProfileIds = Array.from(new Set(explicitProfileIds));
  } else if (payload.data.attachAdapterId) {
    const manualProfileId = `manual:${payload.data.attachAdapterId}`;
    if (!nextSelectedProfileIds.includes(manualProfileId) && snapshot.profiles.some((profile) => profile.profileId === manualProfileId)) {
      nextSelectedProfileIds = [...nextSelectedProfileIds, manualProfileId];
    }
  }

  const availableProfiles = new Set(snapshot.profiles.map((profile) => profile.profileId));
  const missingProfiles = nextSelectedProfileIds.filter((profileId) => !availableProfiles.has(profileId));
  if (missingProfiles.length > 0) {
    return NextResponse.json({ error: `Unknown adapter selection: ${missingProfiles.join(", ")}` }, { status: 404 });
  }

  for (const profile of stateStore.getDeviceProfiles(id)) {
    if (!nextSelectedProfileIds.includes(profile.profileId)) {
      continue;
    }
    if (!isRecord(profile.draftJson) || profile.draftJson.manuallyRejected !== true) {
      continue;
    }
    stateStore.upsertDeviceProfile({
      ...profile,
      draftJson: {
        ...profile.draftJson,
        manuallyRejected: false,
      },
      updatedAt: new Date().toISOString(),
    });
    changedManually = true;
  }

  if (changedManually) {
    snapshot = await startDeviceAdoption(id, { triggeredBy: "user" });
  }

  if ("accessMethodKeys" in payload.data) {
    const available = new Set(snapshot.accessMethods.map((method) => method.key));
    nextSelectedAccessMethodKeys = payload.data.accessMethodKeys ?? [];
    const missing = nextSelectedAccessMethodKeys.filter((key) => !available.has(key));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Unknown access method selection: ${missing.join(", ")}` }, { status: 404 });
    }
  } else if (
    payload.data.attachAdapterId
    || payload.data.removeProfileId
    || payload.data.updateProfile
    || explicitProfileIds.length > 0
    || "profileIds" in payload.data
    || payload.data.profileId
  ) {
    nextSelectedAccessMethodKeys = deriveAccessMethodKeys(
      nextSelectedProfileIds,
      snapshot.profiles,
      snapshot.accessMethods,
      selectedAccessMethodKeysFromSnapshot(snapshot),
    );
  }

  const nextSnapshot = await updateDeviceOnboardingDraft({
    deviceId: id,
    selectedProfileIds: nextSelectedProfileIds,
    selectedAccessMethodKeys: nextSelectedAccessMethodKeys,
    actor: "user",
  });

  await stateStore.addAction({
    actor: "user",
    kind: "config",
    message: `Updated adapter bindings for ${device.name}`,
    context: {
      deviceId: id,
      profileIds: nextSelectedProfileIds,
      accessMethodKeys: nextSelectedAccessMethodKeys,
      attachAdapterId: payload.data.attachAdapterId ?? null,
      removeProfileId: payload.data.removeProfileId ?? null,
      updatedProfileId: payload.data.updateProfile?.profileId ?? null,
    },
  });

  return NextResponse.json(nextSnapshot);
}
