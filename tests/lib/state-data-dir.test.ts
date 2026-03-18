import { describe, expect, it } from "vitest";

import { resolveDataDirForCwd } from "@/lib/state/db";

describe("resolveDataDirForCwd", () => {
  it("uses the repo-root .steward directory for a normal workspace cwd", () => {
    expect(resolveDataDirForCwd("C:\\Users\\bsaunders\\Documents\\steward")).toBe(
      "C:\\Users\\bsaunders\\Documents\\steward\\.steward",
    );
  });

  it("maps Next standalone cwd values back to the repo-root .steward directory", () => {
    expect(resolveDataDirForCwd("C:\\Users\\bsaunders\\Documents\\steward\\.next\\standalone")).toBe(
      "C:\\Users\\bsaunders\\Documents\\steward\\.steward",
    );
  });

  it("maps staged production runtime cwd values back to the repo-root .steward directory", () => {
    expect(resolveDataDirForCwd("C:\\Users\\bsaunders\\Documents\\steward\\build\\standalone-runtime-1773853233025-39596")).toBe(
      "C:\\Users\\bsaunders\\Documents\\steward\\.steward",
    );
  });
});
