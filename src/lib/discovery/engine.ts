import { collectActiveCandidates } from "@/lib/discovery/active";
import { mergeDiscoveryCandidates } from "@/lib/discovery/classify";
import { collectPassiveCandidates } from "@/lib/discovery/passive";
import type { DiscoverySnapshot } from "@/lib/discovery/types";

export const runDiscovery = async (): Promise<DiscoverySnapshot> => {
  const passive = await collectPassiveCandidates();
  const active = await collectActiveCandidates(passive.map((candidate) => candidate.ip));

  return {
    discoveredAt: new Date().toISOString(),
    passive,
    active,
    merged: mergeDiscoveryCandidates([...passive, ...active]),
  };
};
