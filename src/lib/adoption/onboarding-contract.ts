import type {
  OnboardingAssuranceProposal,
  OnboardingResponsibilityProposal,
  OnboardingSynthesis,
} from "@/lib/adoption/conversation";
import type {
  OnboardingDraftAssurance,
  OnboardingDraftWorkload,
} from "@/lib/state/types";

function slugifyContractKey(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function dedupeStrings(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values ?? []) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function clampIntervalSec(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 120;
  }
  return Math.max(15, Math.min(3600, Math.floor(value ?? 120)));
}

export function buildDraftWorkloadsFromResponsibilities(
  responsibilities: OnboardingResponsibilityProposal[] | undefined,
): OnboardingDraftWorkload[] {
  return (responsibilities ?? []).flatMap((responsibility, idx) => {
    const displayName = responsibility.displayName?.trim() ?? "";
    if (!displayName) {
      return [];
    }

    return [{
      workloadKey: responsibility.workloadKey?.trim() || slugifyContractKey(displayName, `responsibility_${idx + 1}`),
      displayName,
      category: responsibility.category ?? "unknown",
      criticality: responsibility.criticality ?? "medium",
      summary: responsibility.summary?.trim() || undefined,
      evidenceJson: {
        source: "onboarding_contract_review",
        proposalId: responsibility.id,
      },
    }];
  });
}

export function buildDraftAssurancesFromProposals(args: {
  assurances: OnboardingAssuranceProposal[] | undefined;
  workloads: OnboardingDraftWorkload[];
}): OnboardingDraftAssurance[] {
  const workloadAliases = new Map<string, string>();
  for (const workload of args.workloads) {
    const aliases = [
      workload.workloadKey,
      workload.displayName,
      slugifyContractKey(workload.displayName, workload.workloadKey),
    ];
    for (const alias of aliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized || workloadAliases.has(normalized)) {
        continue;
      }
      workloadAliases.set(normalized, workload.workloadKey);
    }
  }

  return (args.assurances ?? []).flatMap((assurance, idx) => {
    const assuranceKey = assurance.assuranceKey?.trim() || slugifyContractKey(assurance.displayName ?? "", `assurance_${idx + 1}`);
    const displayName = assurance.displayName?.trim() ?? "";
    if (!assuranceKey || !displayName) {
      return [];
    }

    const serviceKey = assurance.serviceKey?.trim() || assurance.assuranceKey?.trim() || "";
    const mappedWorkloadKey = serviceKey
      ? workloadAliases.get(serviceKey.toLowerCase())
        ?? workloadAliases.get(slugifyContractKey(serviceKey, serviceKey).toLowerCase())
      : undefined;

    return [{
      assuranceKey,
      workloadKey: mappedWorkloadKey,
      displayName,
      criticality: assurance.criticality ?? "medium",
      desiredState: "running",
      checkIntervalSec: clampIntervalSec(assurance.checkIntervalSec),
      monitorType: assurance.monitorType?.trim() || undefined,
      requiredProtocols: dedupeStrings(assurance.requiredProtocols),
      rationale: assurance.rationale?.trim() || undefined,
      configJson: {
        source: "onboarding_contract_review",
        proposalId: assurance.id,
      },
    }];
  });
}

export function buildDraftSeedFromSynthesis(
  synthesis: Pick<OnboardingSynthesis, "summary" | "responsibilities" | "assurances" | "nextActions">,
): {
  summary: string;
  workloads: OnboardingDraftWorkload[];
  assurances: OnboardingDraftAssurance[];
  nextActions: string[];
} {
  const workloads = buildDraftWorkloadsFromResponsibilities(synthesis.responsibilities);
  const assurances = buildDraftAssurancesFromProposals({
    assurances: synthesis.assurances,
    workloads,
  });

  return {
    summary: synthesis.summary?.trim() || "",
    workloads,
    assurances,
    nextActions: dedupeStrings(synthesis.nextActions),
  };
}

export function hasDraftProposalContent(args: {
  summary?: string;
  workloads?: OnboardingDraftWorkload[];
  assurances?: OnboardingDraftAssurance[];
  nextActions?: string[];
  residualUnknowns?: string[];
}): boolean {
  return Boolean(
    (args.workloads?.length ?? 0) > 0
      || (args.assurances?.length ?? 0) > 0,
  );
}
