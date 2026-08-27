import { describe, expect, it } from "vitest";
import {
  importSafeDriverPlan,
  makeExplicitBootstrapOptions,
  writeSafeDriverImport,
  type WorkMapToolClient,
} from "../../src/importer/safedriver-importer.js";

function importedPlan() {
  return importSafeDriverPlan({
    repository: "example/safe-driver-plan",
    ref: "origin/main",
    commit: "main1234",
    generatedAt: "2026-08-27T12:00:00.000Z",
    authors: [{ id: "github:alice", displayName: "Alice", commits: 1 }],
    commits: [
      {
        sha: "main1234",
        subject: "Add employee roster",
        author: { id: "github:alice", displayName: "Alice" },
        files: ["frontend/src/pages/EmployeeListPage.jsx"],
      },
    ],
    files: ["frontend/src/pages/EmployeeListPage.jsx"],
  });
}

function fakeTools(calls: string[], createdInputs: Array<Record<string, unknown>> = []): WorkMapToolClient {
  let nextWork = 0;
  return {
    async list(input) {
      calls.push(`list:${String(input.kind)}`);
      return { items: [], next_cursor: null };
    },
    async search(input) {
      calls.push(`search:${String(input.query)}`);
      return { items: [], next_cursor: null };
    },
    async read(input) {
      calls.push(`read:${String(input.ref)}`);
      throw new Error("not found");
    },
    async create_work(input) {
      const ref = `work_import_${nextWork++}`;
      calls.push(`create_work:${String(input.title)}:${String(input.parent)}`);
      createdInputs.push(input);
      return { work: { ref, ...input, revision: 1 } };
    },
    async update_work(input) {
      calls.push(`update_work:${String(input.ref)}`);
      return { work: { ref: input.ref, revision: Number(input.expected_revision) + 1 } };
    },
    async update_teammate(input) {
      calls.push(`update_teammate:${String(input.ref)}`);
      return { teammate: { ref: input.ref, revision: 1 } };
    },
  };
}

describe("Safe Driver Plan MCP writer", () => {
it("writer refuses to turn inferred owners into Team Ground Truth", async () => {
  const calls: string[] = [];
  await expect(
    writeSafeDriverImport(importedPlan(), fakeTools(calls), { confirmedOwners: {}, confirmedStates: {} }),
  ).rejects.toThrow("Explicit human confirmation is required");
  expect(calls).toEqual([]);
});

it("writer refuses to persist an inferred current state without confirmation", async () => {
  const calls: string[] = [];
  const owners = {
    "sdp:platform": { teammateRef: "teammate_alice", displayName: "Alice" },
    "sdp:employee-foundation": { teammateRef: "teammate_alice", displayName: "Alice" },
  };
  await expect(
    writeSafeDriverImport(importedPlan(), fakeTools(calls), { confirmedOwners: owners, confirmedStates: {} }),
  ).rejects.toThrow("Explicit state confirmation is required");
  expect(calls).toEqual([]);
});

it("writer applies confirmed import through shared MCP tools in parent-first order", async () => {
  const calls: string[] = [];
  const result = await writeSafeDriverImport(importedPlan(), fakeTools(calls), {
    confirmedOwners: {
      "sdp:platform": { teammateRef: "teammate_alice", displayName: "Alice" },
      "sdp:employee-foundation": { teammateRef: "teammate_alice", displayName: "Alice" },
    },
    confirmedStates: {
      "sdp:platform": "current",
      "sdp:employee-foundation": "current",
    },
  });

  expect(result.createdWorkIds).toEqual(["sdp:platform", "sdp:employee-foundation"]);
  expect(result.workRefs["sdp:platform"]).toBe("work_import_0");
  expect(result.workRefs["sdp:employee-foundation"]).toBe("work_import_1");
  expect(calls[0]).toBe("list:teammate");
  expect(calls[1]).toBe("update_teammate:teammate_alice");
  expect(calls[2]).toBe("list:work");
  expect(calls[3]).toBe("create_work:Safe Driver Plan:null");
  expect(calls[4]).toBe("create_work:Employee roster and identity foundation:work_import_0");
});

it("persists an explicitly confirmed owner as confirmed provenance", async () => {
  const calls: string[] = [];
  const createdInputs: Array<Record<string, unknown>> = [];
  const result = await writeSafeDriverImport(importedPlan(), fakeTools(calls, createdInputs), {
    confirmedOwners: {
      "sdp:platform": { teammateRef: "teammate_alice", displayName: "Alice" },
      "sdp:employee-foundation": { teammateRef: "teammate_alice", displayName: "Alice" },
    },
    confirmedStates: {
      "sdp:platform": "current",
      "sdp:employee-foundation": "current",
    },
  });

  expect(result.createdWorkIds).toEqual(["sdp:platform", "sdp:employee-foundation"]);
  expect(createdInputs.map((input) => input.owner_source)).toEqual(["confirmed", "confirmed"]);
});

it("only creates all-to-one bootstrap confirmation when the caller supplies it", () => {
  const options = makeExplicitBootstrapOptions(importedPlan(), {
    teammateRef: "teammate_e2023",
    displayName: "E2023",
    state: "current",
  });
  expect(Object.keys(options.confirmedOwners)).toEqual(["sdp:platform", "sdp:employee-foundation"]);
  expect(Object.values(options.confirmedStates)).toEqual(["current", "current"]);
});

it("matches existing compact Work rows without requiring a search-result kind", async () => {
  const imported = importedPlan();
  const options = makeExplicitBootstrapOptions(imported, {
    teammateRef: "teammate_alice",
    displayName: "Alice",
    state: "current",
  });
  const root = imported.workNodes.find((node) => node.id === "sdp:platform")!;
  const employee = imported.workNodes.find((node) => node.id === "sdp:employee-foundation")!;
  const calls: string[] = [];
  const tools: WorkMapToolClient = {
    async list(input) {
      return input.kind === "teammate"
        ? { items: [{ ref: "teammate_alice", display_name: "Alice", revision: 1 }], next_cursor: null }
        : { items: [
            { ref: "work_root", title: root.title, revision: 1 },
            { ref: "work_employee", title: employee.title, revision: 1 },
          ], next_cursor: null };
    },
    async search() { return { items: [], next_cursor: null }; },
    async read(input) {
      if (input.ref === "teammate_alice") return { entity: { ref: input.ref, display_name: "Alice", memory: "stale", revision: 1 } };
      const node = input.ref === "work_root" ? root : employee;
      return { entity: {
        ref: input.ref,
        title: node.title,
        owner: "teammate_alice",
        state: "current",
        parent: input.ref === "work_root" ? null : "work_root",
        dependencies: [],
        current_summary: "stale",
        living_doc_markdown: "stale",
        revision: 1,
      } };
    },
    async create_work() { throw new Error("must not create duplicate Work"); },
    async update_work(input) { calls.push(`update:${String(input.ref)}`); return { work: { ref: input.ref, revision: 2 } }; },
    async update_teammate(input) { return { teammate: { ref: input.ref, revision: 2 } }; },
  };

  const result = await writeSafeDriverImport(imported, tools, options);
  expect(result.createdWorkIds).toEqual([]);
  expect(result.updatedWorkIds).toEqual(["sdp:platform", "sdp:employee-foundation"]);
  expect(calls).toEqual(["update:work_root", "update:work_employee"]);
});

it("is idempotent when PostgreSQL jsonb returns evidence keys in a different order", async () => {
  const imported = importedPlan();
  const options = makeExplicitBootstrapOptions(imported, {
    teammateRef: "teammate_alice",
    displayName: "Alice",
    state: "current",
  });
  const nodes = imported.workNodes;
  const refs = new Map(nodes.map((node, index) => [node.id, `work_${index}`]));
  const calls: string[] = [];
  const tools: WorkMapToolClient = {
    async list(input) {
      return input.kind === "teammate"
        ? { items: [{ ref: "teammate_alice", display_name: "Alice", revision: 1 }], next_cursor: null }
        : { items: nodes.map((node) => ({ ref: refs.get(node.id), title: node.title, revision: 1 })), next_cursor: null };
    },
    async search() { return { items: [], next_cursor: null }; },
    async read(input) {
      if (input.ref === "teammate_alice") return { entity: { ref: input.ref, display_name: "Alice", memory: "stale", revision: 1 } };
      const node = nodes.find((candidate) => refs.get(candidate.id) === input.ref)!;
      const reorderedEvidence = node.owner.evidence.map((evidence) => Object.fromEntries(Object.entries(evidence).reverse()));
      return { entity: {
        ref: input.ref,
        title: node.title,
        owner: "teammate_alice",
        owner_source: "confirmed",
        owner_evidence: reorderedEvidence,
        state: "current",
        parent: node.parentId ? refs.get(node.parentId) : null,
        dependencies: [],
        current_summary: node.currentSummary,
        living_doc_markdown: node.livingDoc.content,
        revision: 1,
      } };
    },
    async create_work() { throw new Error("must not create duplicate Work"); },
    async update_work(input) { calls.push(`update:${String(input.ref)}`); return { work: { ref: input.ref, revision: 2 } }; },
    async update_teammate(input) { return { teammate: { ref: input.ref, revision: 2 } }; },
  };

  const result = await writeSafeDriverImport(imported, tools, options);
  expect(result.updatedWorkIds).toEqual([]);
  expect(result.unchangedWorkIds).toEqual(nodes.map((node) => node.id));
  expect(calls).toEqual([]);
});
});
