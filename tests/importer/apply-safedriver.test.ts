import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { InMemoryWorkMapRepository } from "../../src/db/in-memory-repository.js";
import { createMcpServer } from "../../src/server/mcp.js";
import {
  formatSafeDriverSummary,
  parseApplySafeDriverArgs,
  runSafeDriverImport,
  type SafeDriverCliOptions,
} from "../../src/importer/apply-safedriver.js";
import {
  createWorkMapToolClient,
  importSafeDriverPlan,
  type WorkMapToolClient,
} from "../../src/importer/safedriver-importer.js";

function importedPlan() {
  return importSafeDriverPlan({
    repository: "example/safe-driver-plan",
    ref: "origin/main",
    commit: "main1234",
    generatedAt: "2026-08-27T12:00:00.000Z",
    commits: [{
      sha: "main1234",
      subject: "Add employee roster",
      author: { id: "github:alice", displayName: "Alice" },
      files: ["frontend/src/pages/EmployeeListPage.jsx"],
    }],
    files: ["frontend/src/pages/EmployeeListPage.jsx"],
  });
}

const defaults: SafeDriverCliOptions = {
  repoPath: "/tmp/safe-driver-plan",
  includePullRequests: true,
  apply: false,
  confirmInferredOwnerAndState: false,
};

describe("Safe Driver apply CLI", () => {
  it("defaults to a dry-run preview and parses explicit apply confirmation", () => {
    expect(parseApplySafeDriverArgs(["/repo"])).toMatchObject({
      repoPath: "/repo",
      apply: false,
      confirmInferredOwnerAndState: false,
      includePullRequests: true,
    });
    expect(parseApplySafeDriverArgs([
      "/repo",
      "--apply",
      "--confirm-inferred-owner-and-state",
      "--teammate-ref",
      "teammate_alice",
      "--display-name",
      "Alice",
      "--state",
      "completed",
    ])).toMatchObject({
      apply: true,
      confirmInferredOwnerAndState: true,
      teammateRef: "teammate_alice",
      displayName: "Alice",
      state: "completed",
    });
  });

  it("rejects apply unless every human confirmation flag is present", () => {
    for (const args of [
      ["--apply"],
      ["--apply", "--confirm-inferred-owner-and-state"],
      ["--apply", "--confirm-inferred-owner-and-state", "--teammate-ref", "teammate_alice"],
      ["--apply", "--confirm-inferred-owner-and-state", "--teammate-ref", "teammate_alice", "--display-name", "Alice"],
    ]) {
      expect(() => parseApplySafeDriverArgs(args)).toThrow(/requires|must be provided/iu);
    }
  });

  it("rejects invalid state, teammate refs, and unknown flags", () => {
    expect(() => parseApplySafeDriverArgs(["--state", "open"])).toThrow("--state");
    expect(() => parseApplySafeDriverArgs([
      "--apply",
      "--confirm-inferred-owner-and-state",
      "--teammate-ref",
      "alice",
      "--display-name",
      "Alice",
      "--state",
      "current",
    ])).toThrow("--teammate-ref");
    expect(() => parseApplySafeDriverArgs(["--surprise"])).toThrow("Unknown option");
  });

  it("uses the shared MCP writer in dry-run mode without creating anything", async () => {
    const repository = new InMemoryWorkMapRepository();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(repository);
    await server.connect(serverTransport);
    const client = new Client({ name: "safedriver-cli-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const result = await runSafeDriverImport(
        importedPlan(),
        createWorkMapToolClient({ callTool: (request) => client.callTool(request) }),
        defaults,
      );

      expect(result.mode).toBe("preview");
      expect(result.write.plannedOperations.length).toBeGreaterThan(0);
      expect(result.write.createdWorkIds).toHaveLength(2);
      const workList = await client.callTool({ name: "list", arguments: { kind: "work", filters: {}, limit: 100 } });
      const teammateList = await client.callTool({ name: "list", arguments: { kind: "teammate", filters: {}, limit: 100 } });
      expect(workList.structuredContent).toMatchObject({ items: [] });
      expect(teammateList.structuredContent).toMatchObject({ items: [] });
    } finally {
      await client.close();
      await repository.close();
    }
  });

  it("requires the confirmation marker again at the writer seam", async () => {
    const tools: WorkMapToolClient = {
      list: async () => ({ items: [], next_cursor: null }),
      search: async () => ({ items: [], next_cursor: null }),
      read: async () => ({ entity: {} }),
      create_work: async () => ({ work: { ref: "work_unused" } }),
      update_work: async () => ({ work: { ref: "work_unused" } }),
      update_teammate: async () => ({ teammate: { ref: "teammate_unused" } }),
    };
    await expect(runSafeDriverImport(importedPlan(), tools, {
      ...defaults,
      apply: true,
      teammateRef: "teammate_alice",
      displayName: "Alice",
      state: "current",
      confirmInferredOwnerAndState: false,
    })).rejects.toThrow("--confirm-inferred-owner-and-state");
  });

  it("makes explicit confirmation visible in apply summaries", () => {
    const imported = importedPlan();
    const summary = formatSafeDriverSummary({
      mode: "apply",
      imported,
      write: {
        teammateRefs: {}, workRefs: {}, createdWorkIds: [], updatedWorkIds: [], unchangedWorkIds: [], plannedOperations: [],
      },
    });
    expect(summary).toContain("explicitly supplied by the operator");
    expect(summary).not.toContain("No writes performed");
  });
});
