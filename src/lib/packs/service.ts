import { randomUUID } from "node:crypto";
import type { PackManifest, PackRecord, PackSignerRecord } from "@/lib/autonomy/types";
import { validatePackManifest } from "@/lib/autonomy/pack-validation";
import { packRepository } from "@/lib/packs/repository";
import { verifyPackSignature } from "@/lib/packs/signing";

function nowIso(): string {
  return new Date().toISOString();
}

function resolvedVerification(input: {
  manifest: PackManifest;
  trustMode: PackRecord["trustMode"];
  signerId?: string;
  signature?: string;
}): {
  signer?: PackSignerRecord;
  trustMode: PackRecord["trustMode"];
  signature?: string;
  signatureAlgorithm?: string;
  verificationStatus: PackRecord["verificationStatus"];
  verifiedAt?: string;
} {
  if (input.trustMode === "builtin") {
    return {
      trustMode: "builtin",
      verificationStatus: "builtin",
      verifiedAt: nowIso(),
    };
  }

  if (!input.signerId || !input.signature) {
    if (input.trustMode === "verified") {
      throw new Error("Verified packs require signerId and signature.");
    }
    return {
      trustMode: "unsigned",
      verificationStatus: "unsigned",
    };
  }

  const signer = packRepository.getSignerById(input.signerId);
  if (!signer) {
    throw new Error("Pack signer not found.");
  }
  if (!verifyPackSignature({
    manifest: input.manifest,
    signer,
    signature: input.signature,
  })) {
    throw new Error("Pack signature verification failed.");
  }

  return {
    signer,
    trustMode: "verified",
    signature: input.signature,
    signatureAlgorithm: signer.algorithm,
    verificationStatus: "verified",
    verifiedAt: nowIso(),
  };
}

export function buildPackDetail(pack: PackRecord) {
  return {
    pack,
    resources: packRepository.listResources(pack.id),
    versions: packRepository.listVersions(pack.id),
  };
}

export function createManagedPack(input: {
  enabled: boolean;
  trustMode: PackRecord["trustMode"];
  manifest: unknown;
  signerId?: string;
  signature?: string;
}): PackRecord {
  const manifest = validatePackManifest(input.manifest);
  const verification = resolvedVerification({
    manifest,
    trustMode: input.trustMode,
    signerId: input.signerId,
    signature: input.signature,
  });

  const now = nowIso();
  return packRepository.upsert({
    id: `pack.managed.${randomUUID()}`,
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    kind: "managed",
    enabled: input.enabled,
    builtin: false,
    trustMode: verification.trustMode,
    signerId: verification.signer?.id,
    signature: verification.signature,
    signatureAlgorithm: verification.signatureAlgorithm,
    verificationStatus: verification.verificationStatus,
    verifiedAt: verification.verifiedAt,
    manifestJson: manifest,
    installedAt: now,
    updatedAt: now,
  });
}

export function updateManagedPack(pack: PackRecord, input: {
  enabled?: boolean;
  trustMode?: PackRecord["trustMode"];
  manifest?: unknown;
  signerId?: string | null;
  signature?: string | null;
}): PackRecord {
  const manifest = input.manifest !== undefined
    ? validatePackManifest(input.manifest)
    : pack.manifestJson;
  const requestedTrustMode = input.trustMode ?? pack.trustMode;
  const verification = resolvedVerification({
    manifest,
    trustMode: requestedTrustMode,
    signerId: input.signerId === undefined ? pack.signerId : input.signerId ?? undefined,
    signature: input.signature === undefined ? pack.signature : input.signature ?? undefined,
  });

  return packRepository.upsert({
    ...pack,
    enabled: input.enabled ?? pack.enabled,
    slug: manifest.slug,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    trustMode: verification.trustMode,
    signerId: verification.signer?.id,
    signature: verification.signature,
    signatureAlgorithm: verification.signatureAlgorithm,
    verificationStatus: verification.verificationStatus,
    verifiedAt: verification.verifiedAt,
    manifestJson: manifest,
    updatedAt: nowIso(),
  });
}
