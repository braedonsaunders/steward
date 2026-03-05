import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterManifest, StewardAdapter } from "@/lib/adapters/types";
import { normalizeToolSkills } from "@/lib/adapters/skills";

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const ManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().default("0.0.0"),
  author: z.string().default(""),
  entry: z.string().default("index.js"),
  provides: z.array(
    z.enum(["discovery", "playbooks", "enrichment", "protocol"]),
  ),
  configSchema: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(["string", "number", "boolean", "select", "json"]),
      required: z.boolean().optional(),
      default: z.unknown().optional(),
      placeholder: z.string().optional(),
      multiline: z.boolean().optional(),
      secret: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      options: z.array(
        z.object({
          label: z.string().min(1),
          value: z.union([z.string(), z.number(), z.boolean()]),
        }),
      ).optional(),
    }),
  ).default([]),
  defaultConfig: z.record(z.string(), z.unknown()).default({}),
  toolSkills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      enabledByDefault: z.boolean().optional(),
      defaultConfig: z.record(z.string(), z.unknown()).optional(),
      toolCall: z.object({
        name: z.string().min(1).max(128),
        description: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()),
      }).optional(),
      execution: z.object({
        kind: z.enum([
          "shell.command",
          "service.restart",
          "service.stop",
          "container.restart",
          "container.stop",
          "http.request",
          "cert.renew",
          "file.copy",
          "network.config",
        ]).optional(),
        mode: z.enum(["read", "mutate"]).optional(),
        adapterId: z.string().min(1).optional(),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
        expectedSemanticTarget: z.string().min(1).optional(),
        commandTemplate: z.string().min(1).optional(),
        commandTemplates: z.record(z.string(), z.string()).optional(),
      }).optional(),
      skillMdPath: z.string().min(1).optional(),
      operationKinds: z.array(
        z.enum([
          "shell.command",
          "service.restart",
          "service.stop",
          "container.restart",
          "container.stop",
          "http.request",
          "cert.renew",
          "file.copy",
          "network.config",
        ]),
      ).optional(),
    }),
  ).default([]),
  defaultToolConfig: z.record(
    z.string(),
    z.record(z.string(), z.unknown()),
  ).default({}),
  docsUrl: z.string().url().optional(),
  skillMdPath: z.string().min(1).optional(),
});

export function parseManifest(input: unknown): AdapterManifest {
  const result = ManifestSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid adapter manifest: ${result.error.flatten().fieldErrors}`,
    );
  }

  return {
    ...result.data,
    toolSkills: normalizeToolSkills(result.data.toolSkills),
  };
}

export function readManifest(adapterDir: string): AdapterManifest {
  const manifestPath = path.join(adapterDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${adapterDir}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  try {
    return parseManifest(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid manifest in ${adapterDir}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Dynamic module loading
// ---------------------------------------------------------------------------

export async function loadAdapterModule(
  adapterDir: string,
  manifest: AdapterManifest,
): Promise<StewardAdapter> {
  const entryPath = path.resolve(adapterDir, manifest.entry ?? "index.js");
  if (!existsSync(entryPath)) {
    throw new Error(
      `Adapter entry file not found: ${entryPath}`,
    );
  }

  // Use file:// URL for ESM dynamic import compatibility
  const fileUrl = pathToFileURL(entryPath).href;

  try {
    const mod = await import(/* webpackIgnore: true */ fileUrl);
    const adapter: StewardAdapter = mod.default ?? mod.adapter ?? mod;

    // Basic shape validation
    if (typeof adapter !== "object" || adapter === null) {
      throw new Error("Adapter entry must export an object");
    }

    return adapter;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load adapter module ${entryPath}: ${message}`);
  }
}
