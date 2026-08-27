import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { InMemoryWorkMapRepository } from "../../src/db/in-memory-repository.js";
import { createMcpServer } from "../../src/server/mcp.js";
import {
  createWorkMapToolClient,
  importSafeDriverPlan,
  makeExplicitBootstrapOptions,
  writeSafeDriverImport,
} from "../../src/importer/safedriver-importer.js";

describe("Safe Driver Plan importer MCP seam", () => {
  it("writes confirmed import data through the running V1 MCP server", async () => {
    const repository = new InMemoryWorkMapRepository();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(repository);
    await server.connect(serverTransport);
    const client = new Client({ name: "safedriver-importer-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const imported = importSafeDriverPlan({
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
      const result = await writeSafeDriverImport(
        imported,
        createWorkMapToolClient({ callTool: (request) => client.callTool(request) }),
        makeExplicitBootstrapOptions(imported, {
          teammateRef: "teammate_alice",
          displayName: "Alice",
          state: "current",
        }),
      );

      expect(result.createdWorkIds).toEqual(["sdp:platform", "sdp:employee-foundation"]);
      const read = await client.callTool({ name: "read", arguments: { ref: result.workRefs["sdp:employee-foundation"] } });
      expect(read.structuredContent).toMatchObject({
        entity: {
          title: "Employee roster and identity foundation",
          owner: "teammate_alice",
          owner_source: "confirmed",
          owner_evidence: [expect.objectContaining({ kind: "commit", ref: "main1234" })],
          living_doc_markdown: expect.stringContaining("# Employee roster and identity foundation"),
        },
      });
    } finally {
      await client.close();
      await repository.close();
    }
  });
});
