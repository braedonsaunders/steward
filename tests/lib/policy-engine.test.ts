import { describe, expect, it } from "vitest";
import { defaultPolicyRules } from "@/lib/state/defaults";
import { evaluatePolicy } from "@/lib/policy/engine";
import type { Device } from "@/lib/state/types";

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "device-1",
    name: "GitLab Server",
    ip: "10.0.0.64",
    type: "container-host",
    status: "online",
    autonomyTier: 1,
    environmentLabel: "lab",
    tags: [],
    protocols: ["ssh"],
    services: [],
    firstSeenAt: "2026-03-19T09:00:00.000Z",
    lastSeenAt: "2026-03-19T09:00:00.000Z",
    lastChangedAt: "2026-03-19T09:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

describe("policy engine", () => {
  it("keeps tier-1 high-impact single-device work approval-gated instead of hard-denied", () => {
    const result = evaluatePolicy(
      "D",
      buildDevice(),
      defaultPolicyRules(),
      [],
      {
        blastRadius: "single-device",
        criticality: "high",
        lane: "A",
        recentFailures: 0,
        quarantineActive: false,
      },
    );

    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(result.reason).toContain('Matched rule "Tier 1 – Gate all mutations"');
    expect(result.reason).toContain("High-criticality Class C/D work requires approval.");
  });

  it("still denies production class-d work outside a maintenance window", () => {
    const result = evaluatePolicy(
      "D",
      buildDevice({ environmentLabel: "prod" }),
      defaultPolicyRules(),
      [],
      {
        blastRadius: "single-device",
        criticality: "high",
        lane: "A",
        recentFailures: 0,
        quarantineActive: false,
      },
    );

    expect(result.decision).toBe("DENY");
    expect(result.reason).toContain("Production Class D changes outside a maintenance window are always denied.");
  });
});
