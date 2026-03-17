import { verify } from "node:crypto";
import type { PackManifest, PackSignerRecord } from "@/lib/autonomy/types";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizePackManifest(manifest: PackManifest): string {
  return stableStringify(manifest);
}

export function verifyPackSignature(input: {
  manifest: PackManifest;
  signer: PackSignerRecord;
  signature: string;
}): boolean {
  if (!input.signer.enabled) {
    return false;
  }
  const payload = Buffer.from(canonicalizePackManifest(input.manifest), "utf8");
  const signature = Buffer.from(input.signature, "base64");
  try {
    return verify(null, payload, input.signer.publicKeyPem, signature);
  } catch {
    return false;
  }
}
