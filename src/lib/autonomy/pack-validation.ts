import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PackManifest } from "@/lib/autonomy/types";

const ResourceSchema = z.object({
  type: z.enum([
    "subagent",
    "mission-template",
    "workload-template",
    "assurance-template",
    "finding-template",
    "investigation-heuristic",
    "playbook",
    "briefing-template",
    "report-template",
    "gateway-template",
    "adapter",
    "tool",
    "lab",
  ]),
  key: z.string().min(2).max(120),
  title: z.string().min(2).max(160),
  description: z.string().max(400).optional(),
});

export const PackManifestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  description: z.string().min(4).max(500),
  resources: z.array(ResourceSchema).min(1),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  stewardCompatibility: z.object({
    minimumVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).optional(),
    maximumVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/).optional(),
  }).optional(),
});

function compareVersionPart(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a > b ? 1 : -1;
}

export function compareSemver(left: string, right: string): number {
  const normalize = (value: string) =>
    value.split("-")[0]?.split(".").map((part) => Number.parseInt(part, 10) || 0) ?? [0, 0, 0];
  const [la = 0, lb = 0, lc = 0] = normalize(left);
  const [ra = 0, rb = 0, rc = 0] = normalize(right);
  return compareVersionPart(la, ra) || compareVersionPart(lb, rb) || compareVersionPart(lc, rc);
}

export function currentStewardVersion(): string {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function validatePackManifest(input: unknown): PackManifest {
  const manifest = PackManifestSchema.parse(input);
  const current = currentStewardVersion();
  const minimum = manifest.stewardCompatibility?.minimumVersion;
  const maximum = manifest.stewardCompatibility?.maximumVersion;
  if (minimum && compareSemver(current, minimum) < 0) {
    throw new Error(`Pack requires Steward ${minimum} or newer. Current version is ${current}.`);
  }
  if (maximum && compareSemver(current, maximum) > 0) {
    throw new Error(`Pack supports Steward ${maximum} or older. Current version is ${current}.`);
  }
  return manifest;
}
