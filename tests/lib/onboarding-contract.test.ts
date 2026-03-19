import { describe, expect, it } from "vitest";
import {
  buildDraftSeedFromSynthesis,
  hasDraftProposalContent,
} from "@/lib/adoption/onboarding-contract";

describe("onboarding contract draft helpers", () => {
  it("maps synthesis responsibilities and assurances into onboarding draft rows", () => {
    const draft = buildDraftSeedFromSynthesis({
      summary: "GitLab omnibus contract",
      responsibilities: [
        {
          id: "resp_gitlab",
          displayName: "GitLab availability",
          workloadKey: "gitlab_app",
          category: "application",
          criticality: "high",
          summary: "Keep the GitLab web UI and API reachable.",
        },
      ],
      assurances: [
        {
          id: "assurance_http",
          displayName: "GitLab HTTP health",
          assuranceKey: "gitlab_http",
          serviceKey: "gitlab_app",
          criticality: "high",
          checkIntervalSec: 120,
          requiredProtocols: ["http", "http", "ssh"],
          monitorType: "http_health",
          rationale: "Confirms the core GitLab surface stays reachable.",
        },
      ],
      nextActions: ["Review and commit", "Review and commit", "Add backups"],
    });

    expect(draft.summary).toBe("GitLab omnibus contract");
    expect(draft.workloads).toEqual([
      expect.objectContaining({
        workloadKey: "gitlab_app",
        displayName: "GitLab availability",
        category: "application",
        criticality: "high",
        summary: "Keep the GitLab web UI and API reachable.",
      }),
    ]);
    expect(draft.assurances).toEqual([
      expect.objectContaining({
        assuranceKey: "gitlab_http",
        workloadKey: "gitlab_app",
        displayName: "GitLab HTTP health",
        criticality: "high",
        checkIntervalSec: 120,
        requiredProtocols: ["http", "ssh"],
        monitorType: "http_health",
        rationale: "Confirms the core GitLab surface stays reachable.",
      }),
    ]);
    expect(draft.nextActions).toEqual(["Review and commit", "Add backups"]);
  });

  it("treats summary-only payloads as empty onboarding proposal content", () => {
    expect(hasDraftProposalContent({
      summary: "GitLab omnibus contract",
      workloads: [],
      assurances: [],
      nextActions: ["Commit onboarding"],
    })).toBe(false);

    expect(hasDraftProposalContent({
      summary: "",
      workloads: [{
        workloadKey: "gitlab_app",
        displayName: "GitLab availability",
        criticality: "high",
      }],
      assurances: [],
    })).toBe(true);
  });
});
