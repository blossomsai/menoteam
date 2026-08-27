import { describe, expect, it } from "vitest";
import { importSafeDriverPlan } from "../../src/importer/safedriver-importer.js";

describe("Safe Driver Plan importer", () => {
it("imports a durable feature as current Work with an unconfirmed owner candidate", () => {
  const result = importSafeDriverPlan({
    repository: "blossomsai/safe-driver-plan",
    ref: "origin/main",
    commit: "abc1234",
    generatedAt: "2026-08-27T12:00:00.000Z",
    remoteUrl: "https://github.com/blossomsai/safe-driver-plan",
    authors: [
      { id: "github:E2023", displayName: "E2023", commits: 3 },
    ],
    pullRequests: [
      {
        number: 4,
        title: "Add employee references and guided roster import",
        state: "MERGED",
        author: { id: "github:E2023", displayName: "E2023" },
        headRef: "codex/settings-ui-feedback",
        baseRef: "main",
        url: "https://github.com/blossomsai/safe-driver-plan/pull/4",
        mergedAt: "2026-08-02T22:01:06Z",
      },
    ],
    commits: [
      {
        sha: "abc1234",
        subject: "Add employee references and guided roster import",
        author: { id: "git:E2023", displayName: "E2023" },
        date: "2026-08-02",
        files: [
          "frontend/src/components/EmployeeReferenceReview.jsx",
          "supabase/migrations/20260801_02_record_employee_references.sql",
        ],
      },
    ],
    branches: [
      {
        name: "codex/settings-ui-feedback",
        sha: "abc1234",
        mergedIntoMain: true,
        commits: ["abc1234"],
      },
    ],
    files: [
      "frontend/src/components/EmployeeReferenceReview.jsx",
      "supabase/migrations/20260801_02_record_employee_references.sql",
    ],
  });

  expect(result.schema).toBe("menoteam.work-map.v1");
  expect(result.source.commit).toBe("abc1234");
  expect(result.workNodes.length).toBeGreaterThanOrEqual(1);

  const employee = result.workNodes.find((node) =>
    node.title.toLowerCase().includes("employee")
  );
  expect(employee).toBeDefined();
  expect(employee?.state).toBe("current");
  expect(employee?.owner.confirmed).toBe(false);
  expect(employee?.owner.provenance).toBe("inferred");
  expect(employee?.owner.person?.id).toBe("github:E2023");
  expect(employee?.owner.confidence).toBe("high");
  expect(employee?.owner.evidence.some((item) => item.kind === "pull_request")).toBe(true);
  expect(employee?.livingDoc.content).toContain("Add employee references");
  expect(employee?.livingDoc.content).toContain(
    "[Add employee references and guided roster import](https://github.com/blossomsai/safe-driver-plan/pull/4)"
  );
  expect(employee?.livingDoc.content).toContain(
    "[origin/main @ abc1234](https://github.com/blossomsai/safe-driver-plan/commit/abc1234)"
  );
  const project = result.workNodes.find((node) => node.id === "sdp:platform");
  expect(project?.livingDoc.content).not.toContain("Latest main contains frontend/");
  expect(project?.livingDoc.content).toContain("pull/4");
  expect(result.teammateMemories).toHaveLength(1);
  expect(result.teammateMemories[0]?.person.id).toBe("github:E2023");
});
});
