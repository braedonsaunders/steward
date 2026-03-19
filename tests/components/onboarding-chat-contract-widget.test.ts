import { describe, expect, it } from "vitest";
import {
  buildDraftBackedSynthesis,
  getOnboardingContractCommitState,
} from "@/components/onboarding-chat-contract-widget";
import type { OnboardingDraft } from "@/lib/state/types";

describe("onboarding chat contract widget helpers", () => {
  it("builds a synthesis fallback from the current onboarding draft", () => {
    const draft: OnboardingDraft = {
      version: 1,
      summary: "GitLab omnibus responsibilities",
      selectedProfileIds: ["profile-1"],
      selectedAccessMethodKeys: ["ssh:22"],
      credentialRequests: [],
      workloads: [{
        workloadKey: "gitlab_app",
        displayName: "GitLab application",
        criticality: "high",
        summary: "Keep GitLab web and API reachable.",
      }],
      assurances: [{
        assuranceKey: "gitlab_http",
        workloadKey: "gitlab_app",
        displayName: "GitLab HTTP health",
        criticality: "high",
        checkIntervalSec: 120,
        requiredProtocols: ["http"],
        monitorType: "http_health",
        rationale: "Confirms the GitLab surface remains reachable.",
      }],
      nextActions: ["Commit onboarding"],
      unresolvedQuestions: [],
      residualUnknowns: [],
      dismissedWorkloadKeys: [],
      dismissedAssuranceKeys: [],
      completionReady: true,
    };

    const synthesis = buildDraftBackedSynthesis(draft);

    expect(synthesis?.summary).toBe("GitLab omnibus responsibilities");
    expect(synthesis?.responsibilities).toEqual([
      expect.objectContaining({
        displayName: "GitLab application",
        workloadKey: "gitlab_app",
        criticality: "high",
      }),
    ]);
    expect(synthesis?.assurances).toEqual([
      expect.objectContaining({
        displayName: "GitLab HTTP health",
        assuranceKey: "gitlab_http",
        serviceKey: "gitlab_app",
      }),
    ]);
  });

  it("does not show the missing-profile warning after onboarding is already completed", () => {
    const commitState = getOnboardingContractCommitState({
      run: {
        status: "completed",
        stage: "done",
      },
      profiles: [{
        id: "binding-1",
        deviceId: "device-1",
        profileId: "profile-1",
        status: "selected",
        confidence: 1,
        rationale: "Primary profile",
        metadataJson: {},
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-18T00:00:00.000Z",
      }],
      accessMethods: [],
      draft: {
        version: 1,
        summary: "GitLab omnibus responsibilities",
        selectedProfileIds: ["profile-1"],
        selectedAccessMethodKeys: ["ssh:22"],
        credentialRequests: [],
        workloads: [],
        assurances: [],
        nextActions: [],
        unresolvedQuestions: [],
        residualUnknowns: [],
        dismissedWorkloadKeys: [],
        dismissedAssuranceKeys: [],
        completionReady: true,
      },
    });

    expect(commitState.onboardingCompleted).toBe(true);
    expect(commitState.canCommit).toBe(false);
    expect(commitState.showProfileSelectionWarning).toBe(false);
  });
});
