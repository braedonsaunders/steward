import { readFileSync } from "node:fs";
import { z } from "zod";

const ScenarioSchema = z.object({
  id: z.string().min(2),
  title: z.string().min(2),
  mission: z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional().default(""),
    objective: z.string().optional().default(""),
    subagentId: z.string().optional(),
    priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
    cadenceMinutes: z.number().int().positive().optional().default(60),
    shadowMode: z.boolean().optional().default(false),
    targetJson: z.record(z.string(), z.unknown()).optional().default({}),
  }),
  state: z.object({
    devices: z.array(z.record(z.string(), z.unknown())).default([]),
    incidents: z.array(z.record(z.string(), z.unknown())).default([]),
    recommendations: z.array(z.record(z.string(), z.unknown())).default([]),
    findingsByDevice: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
    workloadsByDevice: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
    assurancesByDevice: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
  }),
  expectations: z.object({
    summaryIncludes: z.string().optional(),
    openInvestigations: z.number().int().min(0).optional(),
    delegationTargetIds: z.array(z.string()).optional(),
  }).default({}),
});

export type MissionLabScenario = z.infer<typeof ScenarioSchema>;

export function parseMissionLabScenario(input: unknown): MissionLabScenario {
  return ScenarioSchema.parse(input);
}

export function loadMissionLabScenario(filePath: string): MissionLabScenario {
  const raw = readFileSync(filePath, "utf8");
  return parseMissionLabScenario(JSON.parse(raw) as unknown);
}
