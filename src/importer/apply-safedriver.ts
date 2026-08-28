import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectAndImportSafeDriverPlan,
  createWorkMapToolClient,
  makeExplicitBootstrapOptions,
  writeSafeDriverImport,
  type ExplicitBootstrapConfirmation,
  type McpToolCaller,
  type WorkMapImport,
  type WorkMapToolClient,
  type WorkState,
  type WriteImportResult,
} from "./safedriver-importer.js";

const TEAMMATE_REF = /^teammate_[A-Za-z0-9_-]+$/u;

export interface SafeDriverCliOptions {
  repoPath: string;
  ref?: string;
  includePullRequests: boolean;
  apply: boolean;
  confirmInferredOwnerAndState: boolean;
  preserveInferredOwner?: boolean;
  teammateRef?: string;
  displayName?: string;
  state?: WorkState;
  help?: boolean;
}

export interface SafeDriverImportRun {
  mode: "preview" | "apply";
  imported: WorkMapImport;
  write: WriteImportResult;
  ownerSource?: "confirmed" | "inferred";
}

export class SafeDriverCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeDriverCliUsageError";
  }
}

export const SAFE_DRIVER_USAGE = `Usage: pnpm exec tsx src/importer/apply-safedriver.ts [repo-path] [options]

Preview is the default and is always dry-run. Apply requires an explicit owner mapping and state. Use the existing confirmation flag for confirmed ownership, or use --preserve-inferred-owner to keep repository ownership inferred:
  --apply (--confirm-inferred-owner-and-state | --preserve-inferred-owner) --teammate-ref teammate_... --display-name NAME --state current|completed

Options:
  --repo PATH       Safe Driver Plan checkout (alternative to the positional path)
  --ref REF         Git ref to collect (default: origin/main)
  --no-pr           Skip optional GitHub pull-request metadata
  --apply           Persist the selected import through the six MCP tools
  --confirm-inferred-owner-and-state
                    Confirm that the supplied human owner and state may be written
  --preserve-inferred-owner
                    Keep the repository owner candidate inferred instead of confirmed
  --teammate-ref REF
  --display-name NAME
  --state current|completed
  --help`;

export function parseApplySafeDriverArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): SafeDriverCliOptions {
  let repoPath: string | undefined;
  let ref: string | undefined;
  let includePullRequests = true;
  let apply = false;
  let confirmInferredOwnerAndState = false;
  let preserveInferredOwner = false;
  let teammateRef: string | undefined;
  let displayName: string | undefined;
  let state: WorkState | undefined;
  let help = false;

  const value = (index: number, option: string): string => {
    const candidate = argv[index + 1];
    if (!candidate || candidate.startsWith("--")) {
      throw new SafeDriverCliUsageError(`${option} requires a value.`);
    }
    return candidate;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--confirm-inferred-owner-and-state") {
      confirmInferredOwnerAndState = true;
    } else if (arg === "--preserve-inferred-owner") {
      preserveInferredOwner = true;
    } else if (arg === "--no-pr") {
      includePullRequests = false;
    } else if (arg === "--repo") {
      repoPath = value(index, arg);
      index += 1;
    } else if (arg === "--ref") {
      ref = value(index, arg);
      index += 1;
    } else if (arg === "--teammate-ref") {
      teammateRef = value(index, arg);
      index += 1;
    } else if (arg === "--display-name") {
      displayName = value(index, arg);
      index += 1;
    } else if (arg === "--state") {
      const candidate = value(index, arg);
      if (candidate !== "current" && candidate !== "completed") {
        throw new SafeDriverCliUsageError(`${arg} must be current or completed.`);
      }
      state = candidate;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new SafeDriverCliUsageError(`Unknown option: ${arg}`);
    } else if (repoPath) {
      throw new SafeDriverCliUsageError(`Unexpected positional argument: ${arg}`);
    } else {
      repoPath = arg;
    }
  }

  const options: SafeDriverCliOptions = {
    repoPath: resolve(cwd, repoPath ?? "."),
    ...(ref ? { ref } : {}),
    includePullRequests,
    apply,
    confirmInferredOwnerAndState,
    preserveInferredOwner,
    ...(teammateRef ? { teammateRef } : {}),
    ...(displayName ? { displayName } : {}),
    ...(state ? { state } : {}),
    ...(help ? { help } : {}),
  };
  if (!help) validateApplyOptions(options);
  return options;
}

function validateApplyOptions(options: SafeDriverCliOptions): void {
  if (!options.apply) return;
  if (options.confirmInferredOwnerAndState && options.preserveInferredOwner) {
    throw new SafeDriverCliUsageError(
      "--confirm-inferred-owner-and-state and --preserve-inferred-owner are mutually exclusive.",
    );
  }
  if (!options.confirmInferredOwnerAndState && !options.preserveInferredOwner) {
    throw new SafeDriverCliUsageError(
      "--apply requires --confirm-inferred-owner-and-state or --preserve-inferred-owner.",
    );
  }
  if (!options.teammateRef?.trim()) {
    throw new SafeDriverCliUsageError("--apply requires --teammate-ref.");
  }
  if (!TEAMMATE_REF.test(options.teammateRef)) {
    throw new SafeDriverCliUsageError("--teammate-ref must match teammate_... .");
  }
  if (!options.displayName?.trim()) {
    throw new SafeDriverCliUsageError("--apply requires --display-name.");
  }
  if (!options.state) {
    throw new SafeDriverCliUsageError("--apply requires --state current|completed.");
  }
}

function previewConfirmation(imported: WorkMapImport): ExplicitBootstrapConfirmation {
  const candidate = imported.workNodes.find((node) => node.owner.person)?.owner.person;
  const suffix = (candidate?.id ?? "unresolved")
    .replace(/[^A-Za-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48) || "unresolved";
  return {
    teammateRef: `teammate_preview_${suffix}`,
    displayName: candidate?.displayName || "Unresolved owner (preview only)",
    state: imported.workNodes[0]?.state ?? "current",
  };
}

/** Run the shared importer writer; preview always passes dryRun to its seam. */
export async function runSafeDriverImport(
  imported: WorkMapImport,
  tools: WorkMapToolClient,
  options: SafeDriverCliOptions,
): Promise<SafeDriverImportRun> {
  validateApplyOptions(options);
  const confirmation = options.apply
    ? {
        teammateRef: options.teammateRef!,
        displayName: options.displayName!,
        state: options.state!,
        ownerSource: options.preserveInferredOwner ? "inferred" as const : "confirmed" as const,
      }
    : options.teammateRef && options.displayName && options.state
      ? {
          teammateRef: options.teammateRef,
          displayName: options.displayName,
          state: options.state,
          ownerSource: options.preserveInferredOwner ? "inferred" as const : "confirmed" as const,
        }
      : {
          ...previewConfirmation(imported),
          ownerSource: options.preserveInferredOwner ? "inferred" as const : "confirmed" as const,
        };
  const writeOptions = makeExplicitBootstrapOptions(imported, confirmation);
  const write = await writeSafeDriverImport(imported, tools, {
    ...writeOptions,
    dryRun: !options.apply,
  });
  return {
    mode: options.apply ? "apply" : "preview",
    imported,
    write,
    ownerSource: writeOptions.ownerSource,
  };
}

export function formatSafeDriverSummary(run: SafeDriverImportRun): string {
  const lines = [
    `Safe Driver Plan import: ${run.mode === "preview" ? "preview (dry-run)" : "apply"}`,
    `Source: ${run.imported.source.repository}@${run.imported.source.ref} (${run.imported.source.commit})`,
    `Work nodes: ${run.imported.workNodes.length}`,
    `Planned operations: ${run.write.plannedOperations.length}`,
    `Created: ${run.write.createdWorkIds.length}`,
    `Updated: ${run.write.updatedWorkIds.length}`,
  ];
  if (run.mode === "preview") {
    lines.push("No writes performed. Inferred owner/state remain unconfirmed until explicit apply flags are supplied.");
  } else if (run.ownerSource === "inferred") {
    lines.push("Owner source: repository inference was preserved as inferred; a human can confirm or override it later.");
  } else {
    lines.push("Owner/state fields: explicitly supplied by the operator; owner provenance preserves repository inference for review.");
  }
  if (run.imported.warnings.length) lines.push(`Warnings: ${run.imported.warnings.join(" | ")}`);
  return `${lines.join("\n")}\n`;
}

interface McpEnvironment {
  WORK_MAP_MCP_URL?: string;
  WORK_MAP_MCP_API_KEY?: string;
}

async function withMcpTools<T>(env: McpEnvironment, action: (tools: WorkMapToolClient) => Promise<T>): Promise<T> {
  const endpoint = env.WORK_MAP_MCP_URL?.trim();
  const apiKey = env.WORK_MAP_MCP_API_KEY?.trim();
  if (!endpoint) throw new SafeDriverCliUsageError("WORK_MAP_MCP_URL is required.");
  if (!apiKey) throw new SafeDriverCliUsageError("WORK_MAP_MCP_API_KEY is required.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SafeDriverCliUsageError("WORK_MAP_MCP_URL must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeDriverCliUsageError("WORK_MAP_MCP_URL must use http or https.");
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "menoteam-safedriver-importer", version: "0.1.1" });
  try {
    await client.connect(transport);
    return await action(createWorkMapToolClient({
      callTool: (request) => client.callTool(request) as unknown as ReturnType<McpToolCaller["callTool"]>,
    }));
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

export async function runApplySafeDriverCli(
  argv: readonly string[] = process.argv.slice(2),
  env: McpEnvironment = process.env,
  output: { write: (text: string) => void } = process.stdout,
): Promise<number> {
  try {
    const options = parseApplySafeDriverArgs(argv);
    if (options.help) {
      output.write(`${SAFE_DRIVER_USAGE}\n`);
      return 0;
    }
    const imported = collectAndImportSafeDriverPlan(options.repoPath, {
      ...(options.ref ? { ref: options.ref } : {}),
      includePullRequests: options.includePullRequests,
    });
    const run = await withMcpTools(env, (tools) => runSafeDriverImport(imported, tools, options));
    output.write(formatSafeDriverSummary(run));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Safe Driver import failed.";
    const secret = env.WORK_MAP_MCP_API_KEY?.trim();
    const safeMessage = secret ? message.split(secret).join("[redacted]") : message;
    process.stderr.write(`Safe Driver import failed: ${safeMessage}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  void runApplySafeDriverCli().then((code) => {
    process.exitCode = code;
  });
}
