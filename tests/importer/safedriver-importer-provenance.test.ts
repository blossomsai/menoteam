import { describe, expect, it } from "vitest";
import { importSafeDriverPlan } from "../../src/importer/safedriver-importer.js";

describe("Safe Driver Plan provenance", () => {
it("keeps unresolved ownership unresolved instead of inventing a human", () => {
  const result = importSafeDriverPlan({
    repository: "example/safe-driver-plan",
    ref: "origin/main",
    commit: "deadbeef",
    generatedAt: "2026-08-27T12:00:00.000Z",
    commits: [
      {
        sha: "deadbeef",
        subject: "Update unrelated metadata",
        files: ["README.md"],
      },
    ],
    files: ["README.md"],
  });

  const feature = result.workNodes.find((node) => node.id === "sdp:employee-foundation");
  expect(feature).toBeUndefined();
  expect(result.workNodes[0]?.owner.status).toBe("unresolved");
  expect(result.workNodes[0]?.owner.provenance).toBe("unresolved");
  expect(result.workNodes[0]?.owner.person).toBeNull();
  expect(result.workNodes[0]?.owner.confirmed).toBe(false);
  expect(result.warnings.some((warning) => warning.includes("candidate inference"))).toBe(true);
});

it("does not import an unmerged branch as durable Work", () => {
  const result = importSafeDriverPlan({
    repository: "example/safe-driver-plan",
    ref: "origin/main",
    commit: "main1234",
    generatedAt: "2026-08-27T12:00:00.000Z",
    authors: [{ id: "github:alice", displayName: "Alice", commits: 1 }],
    commits: [
      {
        sha: "main1234",
        subject: "Keep employee roster stable",
        author: { id: "github:alice", displayName: "Alice" },
        files: ["frontend/src/pages/EmployeeListPage.jsx"],
      },
    ],
    branches: [
      {
        name: "origin/main",
        sha: "main1234",
        mergedIntoMain: true,
        commits: ["main1234"],
      },
      {
        name: "origin/codex/driver-resources-portal",
        sha: "branch999",
        mergedIntoMain: false,
        commits: ["branch999"],
      },
    ],
    files: ["frontend/src/pages/EmployeeListPage.jsx"],
  });

  expect(result.unmergedBranches).toHaveLength(1);
  expect(result.unmergedBranches[0]?.name).toBe("origin/codex/driver-resources-portal");
  expect(result.workNodes.some((node) => node.title.toLowerCase().includes("resource portal"))).toBe(false);
});

it("redacts bearer-like values from titles and paths", () => {
  const result = importSafeDriverPlan({
    repository: "example/safe-driver-plan",
    ref: "origin/main",
    commit: "safe1234",
    generatedAt: "2026-08-27T12:00:00.000Z",
    commits: [
      {
        sha: "safe1234",
        subject: "Add secret=fixture-redaction-marker-1234567890 to employee flow",
        author: { id: "github:alice", displayName: "Alice" },
        files: ["frontend/src/employee/secret.pem"],
      },
    ],
    files: ["frontend/src/employee/secret.pem"],
  });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("fixture-redaction-marker-1234567890");
  expect(serialized).not.toContain("secret.pem");
  expect(serialized).toContain("[redacted]");
});
});
