import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginManifest, StewardPlugin } from "@/lib/plugins/types";

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
});

export function readManifest(pluginDir: string): PluginManifest {
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${pluginDir}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const result = ManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid manifest in ${pluginDir}: ${result.error.flatten().fieldErrors}`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Dynamic module loading
// ---------------------------------------------------------------------------

export async function loadPluginModule(
  pluginDir: string,
  manifest: PluginManifest,
): Promise<StewardPlugin> {
  const entryPath = path.resolve(pluginDir, manifest.entry ?? "index.js");
  if (!existsSync(entryPath)) {
    throw new Error(
      `Plugin entry file not found: ${entryPath}`,
    );
  }

  // Use file:// URL for ESM dynamic import compatibility
  const fileUrl = pathToFileURL(entryPath).href;

  try {
    const mod = await import(/* webpackIgnore: true */ fileUrl);
    const plugin: StewardPlugin = mod.default ?? mod.plugin ?? mod;

    // Basic shape validation
    if (typeof plugin !== "object" || plugin === null) {
      throw new Error("Plugin entry must export an object");
    }

    return plugin;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load plugin module ${entryPath}: ${message}`);
  }
}
