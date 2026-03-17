import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Assurance, AssuranceRun, Device, Incident } from "@/lib/state/types";

const mocks = vi.hoisted(() => ({
  getServiceContracts: vi.fn(),
  getLatestAssuranceRuns: vi.fn(),
  routeFinding: vi.fn(),
}));

vi.mock("@/lib/state/store", () => ({
  stateStore: {
    getServiceContracts: mocks.getServiceContracts,
    getLatestAssuranceRuns: mocks.getLatestAssuranceRuns,
  },
}));

vi.mock("@/lib/findings/router", () => ({
  routeFinding: mocks.routeFinding,
}));

vi.mock("@/lib/discovery/engine", () => ({
  runDiscovery: vi.fn(),
}));

vi.mock("@/lib/discovery/classify", () => ({
  candidateToDevice: vi.fn(),
}));

vi.mock("@/lib/discovery/evidence", () => ({
  dedupeObservations: vi.fn(),
  evaluateDiscoveryEvidence: vi.fn(),
}));

vi.mock("@/lib/discovery/advisor", () => ({
  generateDiscoveryAdvice: vi.fn(),
}));

vi.mock("@/lib/autonomy/runtime", () => ({
  AUTONOMY_JOB_KINDS: [],
  ensureAutonomyBootstrap: vi.fn(),
  processAutonomyJobs: vi.fn(),
  queueDueAutonomyJobs: vi.fn(),
}));

vi.mock("@/lib/protocols/negotiator", () => ({
  buildManagementSurface: vi.fn(),
}));

vi.mock("@/lib/policy/engine", () => ({
  evaluatePolicy: vi.fn(),
}));

vi.mock("@/lib/playbooks/registry", () => ({
  matchPlaybooksForIncident: vi.fn(),
}));

vi.mock("@/lib/playbooks/runtime", () => ({
  executePlaybook: vi.fn(),
}));

vi.mock("@/lib/adoption/playbook-credentials", () => ({
  getMissingCredentialProtocolsForPlaybook: vi.fn(),
}));

vi.mock("@/lib/playbooks/factory", () => ({
  buildPlaybookRun: vi.fn(),
  countRecentFamilyFailures: vi.fn(() => 0),
  criticalityForActionClass: vi.fn(() => "medium"),
  isFamilyQuarantined: vi.fn(() => false),
}));

vi.mock("@/lib/approvals/queue", () => ({
  createApproval: vi.fn(),
  expireStale: vi.fn(),
}));

vi.mock("@/lib/adapters/registry", () => ({
  adapterRegistry: {
    initialize: vi.fn(),
  },
}));

vi.mock("@/lib/devices/protected-metadata", () => ({
  mergeProtectedDeviceMetadata: vi.fn((device: Device) => device),
}));

vi.mock("@/lib/digest/scheduler", () => ({
  ensureDigestScheduler: vi.fn(),
  stopDigestScheduler: vi.fn(),
}));

vi.mock("@/lib/discovery/enrichment-plane", () => ({
  DISCOVERY_ENRICHMENT_BROWSER_JOB_KIND: "browser",
  DISCOVERY_ENRICHMENT_FINGERPRINT_JOB_KIND: "fingerprint",
  DISCOVERY_ENRICHMENT_HOSTNAME_JOB_KIND: "hostname",
  DISCOVERY_ENRICHMENT_JOB_KINDS: [],
  DISCOVERY_ENRICHMENT_NMAP_JOB_KIND: "nmap",
  emptyDiscoveryEnrichmentQueueSummary: () => ({
    queuedJobs: 0,
    phasesWithBacklog: 0,
  }),
  executeDiscoveryEnrichmentJob: vi.fn(),
  planDiscoveryEnrichmentJobs: vi.fn(() => ({
    queuedJobs: 0,
    phasesWithBacklog: 0,
  })),
}));

vi.mock("@/lib/monitoring/contracts", () => ({
  evaluateServiceContract: vi.fn(),
  getMonitorType: (contract: Assurance) => contract.monitorType ?? "unknown",
  getRequiredProtocolsForServiceContract: vi.fn(() => []),
  isServiceContractDue: vi.fn(() => true),
}));

vi.mock("@/lib/local-tools/runtime", () => ({
  localToolRuntime: {
    expireStaleApprovals: vi.fn(),
  },
}));

vi.mock("@/lib/state/device-adoption", () => ({
  getAdoptionRecord: vi.fn(),
  getDeviceAdoptionStatus: vi.fn(),
}));

vi.mock("@/lib/notifications/manager", () => ({
  processNotificationJobs: vi.fn(),
}));

vi.mock("@/lib/protocol-sessions/manager", () => ({
  protocolSessionManager: {
    sweep: vi.fn(),
  },
}));

vi.mock("@/lib/web-sessions/manager", () => ({
  webSessionManager: {
    sweep: vi.fn(),
  },
}));

vi.mock("@/lib/state/graph", () => ({
  graphStore: {},
}));

vi.mock("@/lib/utils/shell", () => ({
  runShell: vi.fn(),
}));

vi.mock("@/lib/widgets/automations", () => ({
  ensureDeviceAutomationScheduler: vi.fn(),
  stopDeviceAutomationScheduler: vi.fn(),
}));

import { applyOperationalFindingPacks } from "@/lib/agent/loop";

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: "device-1",
    name: "edge-01",
    ip: "10.0.4.10",
    type: "router",
    status: "online",
    autonomyTier: 2,
    tags: [],
    protocols: [],
    services: [],
    firstSeenAt: "2026-03-16T00:00:00.000Z",
    lastSeenAt: "2026-03-16T00:00:00.000Z",
    lastChangedAt: "2026-03-16T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function makeContract(overrides: Partial<Assurance> = {}): Assurance {
  return {
    id: "assurance-1",
    deviceId: "device-1",
    assuranceKey: "assurance-1",
    displayName: "Disk pressure",
    criticality: "medium",
    desiredState: "running",
    checkIntervalSec: 3600,
    monitorType: "unknown",
    requiredProtocols: [],
    rationale: "",
    configJson: {},
    createdAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    serviceKey: "assurance-1",
    policyJson: {},
    ...overrides,
  };
}

function makeRun(overrides: Partial<AssuranceRun> = {}): AssuranceRun {
  return {
    id: "run-1",
    assuranceId: "assurance-1",
    deviceId: "device-1",
    status: "pass",
    summary: "Healthy",
    evidenceJson: {},
    evaluatedAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyOperationalFindingPacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routeFinding.mockImplementation(async ({ incidents }: { incidents: Incident[] }) => ({ incidents }));
  });

  it("creates disk-pressure findings and recommendations from assurance evidence", async () => {
    mocks.getServiceContracts.mockReturnValue([
      makeContract({
        id: "disk-1",
        displayName: "Root filesystem pressure",
        monitorType: "disk_pressure",
        criticality: "high",
      }),
    ]);
    mocks.getLatestAssuranceRuns.mockReturnValue([
      makeRun({
        assuranceId: "disk-1",
        status: "fail",
        summary: "Root filesystem is 98% full.",
        evidenceJson: {
          usagePercent: 98,
          thresholdPercent: 90,
        },
      }),
    ]);

    const result = await applyOperationalFindingPacks(makeDevice(), [], []);
    const diskCall = mocks.routeFinding.mock.calls.find(
      ([payload]) => payload.finding.findingType === "disk_pressure",
    )?.[0];

    expect(diskCall.finding.severity).toBe("critical");
    expect(diskCall.finding.status).toBe("open");
    expect(result.recommendationsAdded).toBe(1);
    expect(result.recommendations[0]?.title).toContain("Relieve disk pressure");
  });

  it("creates failed-service findings for service health monitors", async () => {
    mocks.getServiceContracts.mockReturnValue([
      makeContract({
        id: "svc-1",
        displayName: "nginx",
        monitorType: "process_health",
        criticality: "high",
      }),
    ]);
    mocks.getLatestAssuranceRuns.mockReturnValue([
      makeRun({
        assuranceId: "svc-1",
        status: "fail",
        summary: "nginx is not running.",
        evidenceJson: {
          serviceName: "nginx",
        },
      }),
    ]);

    const result = await applyOperationalFindingPacks(makeDevice(), [], []);
    const serviceCall = mocks.routeFinding.mock.calls.find(
      ([payload]) => payload.finding.findingType === "service_failure",
    )?.[0];

    expect(serviceCall.finding.title).toContain("Service health drift");
    expect(serviceCall.finding.status).toBe("open");
    expect(result.recommendations[0]?.title).toContain("Investigate nginx");
  });

  it("creates stale-backup findings when backup evidence falls behind cadence", async () => {
    mocks.getServiceContracts.mockReturnValue([
      makeContract({
        id: "backup-1",
        displayName: "Nightly backup",
        assuranceKey: "nightly-backup",
        serviceKey: "nightly-backup",
        monitorType: "job_status",
      }),
    ]);
    mocks.getLatestAssuranceRuns.mockReturnValue([
      makeRun({
        assuranceId: "backup-1",
        status: "pass",
        summary: "Last run succeeded.",
        evaluatedAt: "2026-03-14T00:00:00.000Z",
      }),
    ]);

    const result = await applyOperationalFindingPacks(makeDevice(), [], []);
    const backupCall = mocks.routeFinding.mock.calls.find(
      ([payload]) => payload.finding.findingType === "backup_staleness",
    )?.[0];

    expect(backupCall.finding.status).toBe("open");
    expect(backupCall.finding.severity).toBe("critical");
    expect(result.recommendations[0]?.title).toContain("Verify backup freshness");
  });

  it("creates open-port drift findings for unexpected sensitive exposures", async () => {
    mocks.getServiceContracts.mockReturnValue([]);
    mocks.getLatestAssuranceRuns.mockReturnValue([]);

    const result = await applyOperationalFindingPacks(
      makeDevice({
        services: [
          {
            id: "svc-ftp",
            port: 21,
            transport: "tcp",
            name: "ftp",
            secure: false,
            lastSeenAt: "2026-03-16T00:00:00.000Z",
          },
          {
            id: "svc-docker",
            port: 2375,
            transport: "tcp",
            name: "docker",
            secure: false,
            lastSeenAt: "2026-03-16T00:00:00.000Z",
          },
        ],
      }),
      [],
      [],
    );

    const portCall = mocks.routeFinding.mock.calls.find(
      ([payload]) => payload.finding.findingType === "open_port_policy_drift",
    )?.[0];

    expect(portCall.finding.status).toBe("open");
    expect(portCall.finding.severity).toBe("critical");
    expect(result.recommendations[0]?.title).toContain("Review open-port policy");
  });
});
