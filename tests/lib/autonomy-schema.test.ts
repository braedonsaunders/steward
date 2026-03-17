import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/state/db";

function tableColumns(table: string): string[] {
  const db = getDb();
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

describe("autonomy schema", () => {
  it("creates autonomy control-plane tables", () => {
    const db = getDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);

    expect(tables).toContain("packs");
    expect(tables).toContain("pack_installs");
    expect(tables).toContain("pack_versions");
    expect(tables).toContain("pack_resources");
    expect(tables).toContain("missions");
    expect(tables).toContain("mission_links");
    expect(tables).toContain("subagents");
    expect(tables).toContain("investigations");
    expect(tables).toContain("gateway_bindings");
    expect(tables).toContain("gateway_threads");
    expect(tables).toContain("gateway_inbound_events");
    expect(tables).toContain("briefings");
  });

  it("includes the latest mission and investigation columns", () => {
    expect(tableColumns("packs")).toContain("trustMode");
    expect(tableColumns("missions")).toContain("shadowMode");
    expect(tableColumns("investigations")).toContain("stage");
    expect(tableColumns("investigations")).toContain("parentInvestigationId");
    expect(tableColumns("investigations")).toContain("recommendedActionsJson");
    expect(tableColumns("investigations")).toContain("unresolvedQuestionsJson");
  });
});
