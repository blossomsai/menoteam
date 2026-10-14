import { isDeepStrictEqual } from 'node:util';
import { verifyExecutionSkills, verifyBundle, type SkillBundle } from '../workbench/skill-bundle.js';
import type { Artifact, Run, RunRecoveryState } from '../workbench/types.js';
import { qaResource } from '../workbench/local-qa.js';
import type { ClaimedRun, ConnectorEvent, ConnectorConfig, UploadArtifact } from './types.js';
import { z } from 'zod';

export class ConnectorHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues: Array<{ path: string; code: string }> = [],
    public readonly method: string = 'OTHER',
    public readonly routeCategory: string = 'unknown',
    public readonly retryAfterSeconds?: number,
  ) { super(message); }

  get safeSummary(): string {
    return `Connector HTTP failure method=${this.method} route=${this.routeCategory} status=${this.status} retryAfterSeconds=${this.retryAfterSeconds ?? 'none'}`;
  }
}

function routeCategory(path: string): string {
  if (path === '/api/workbench/connector/claim') return 'connector.claim';
  const route = path.match(/^\/api\/workbench\/connector\/runs\/[^/]+\/(renew|events|artifacts|stopped|recovery-state|bridge-token|complete|tools|qa-authorize|delivery-authorize|delivery-progress|staging-authorize|staging-progress|staging-build-status|staging-build-receipt)$/u)?.[1];
  if (route) return `connector.runs.${route}`;
  if (/^\/api\/workbench\/connector\/runs\/[^/]+$/u.test(path)) return 'connector.runs.read';
  return 'unknown';
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const header = value.trim();
  if (/^\d{1,6}$/u.test(header)) return Math.min(86_400, Number(header));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(86_400, Math.max(0, Math.ceil((date - Date.now()) / 1000))) : undefined;
}

export class WorkbenchConnectorClient {
  private readonly baseUrl: string;
  private readonly codexModels: string[];
  private readonly modelReasoningEfforts: Record<string, string[]>;

  constructor(private readonly config: Pick<ConnectorConfig, 'serverUrl' | 'token' | 'deploymentTargets'>, private readonly fetcher: typeof fetch = fetch, codexModels: string[] = [], modelReasoningEfforts: Record<string, string[]> = {}) {
    const url = new URL(config.serverUrl);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('Workbench connector URL must use HTTPS except on localhost');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('Workbench connector URL must not contain credentials or query parameters');
    this.baseUrl = url.toString().replace(/\/$/u, '');
    this.codexModels = [...new Set(codexModels)];
    this.modelReasoningEfforts = modelReasoningEfforts;
  }

  async claim(runKinds?: Run['kind'][]): Promise<ClaimedRun | undefined> {
    const deploymentTargets=Object.keys(this.config.deploymentTargets??{});
    const capabilities = {
      codexAppServer: true,
      models: this.codexModels,
      modelReasoningEfforts: this.modelReasoningEfforts,
      localWorktrees: true,
      ...(process.env.MENOTEAM_GITHUB_TOKEN ? {
        git: true,
        githubWrite: true,
        deliveryActions: ['create_draft_pr','merge_pr', ...(deploymentTargets.length ? ['deploy_staging','rollback_staging'] : [])],
      } : {}),
      ...(deploymentTargets.length ? { deploymentTargets } : {}),
      ...(runKinds ? { runKinds: [...new Set(runKinds)] } : {}),
    };
    const result = await this.request<ClaimedRun | undefined>('/api/workbench/connector/claim', {
      method: 'POST', body: { capabilities },
      allowNoContent: true,
    });
    return result;
  }

  renew(runId: string, generation: number): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/renew`, { method: 'POST', body: { generation } });
  }
  authorizeQaEffect(runId:string,generation:number):Promise<{authorized:true}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/qa-authorize`,{method:'POST',body:{generation}});}
  authorizeDeliveryEffect(runId:string,generation:number):Promise<{authorized:true;repositoryUrl:string}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/delivery-authorize`,{method:'POST',body:{generation}});}

  readRun(runId: string): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
  }

  async recoveryState(runId:string,generation:number):Promise<RunRecoveryState> {
    const state=await this.request<RunRecoveryState>(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/recovery-state`,{method:'POST',body:{generation}});
    if(state.id!==runId||state.generation!==generation)throw new Error('Recovery identity mismatch');
    return state;
  }

  appendEvents(runId: string, generation: number, events: ConnectorEvent[]): Promise<{ accepted: boolean }> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/events`, { method: 'POST', body: { generation, events } });
  }

  addArtifact(runId: string, generation: number, artifact: UploadArtifact): Promise<Artifact> {
    const body={ generation, ...artifact };
    if(Buffer.byteLength(JSON.stringify(body),'utf8')>=1_000_000)throw new Error('Serialized artifact POST must be below 1 MiB');
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/artifacts`, {
      method: 'POST', body,
    });
  }
  deliveryProgress(runId:string,generation:number,input:{phase:'published'|'pr_created'|'ready_intent'|'merge_intent'|'merged';remoteHeadSha?:string;pullRequestNumber?:number;pullRequestUrl?:string;headSha?:string;baseSha?:string;mergeSha?:string;pullRequestNodeId?:string}):Promise<{run:Run;artifact:Artifact}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/delivery-progress`,{method:'POST',body:{generation,...input}});}
  authorizeStagingEffect(runId:string,generation:number,effect:'discovery'|'provenance'|'transport'|'status'):Promise<{authorized:true;action:'discover'|'deploy'|'rollback'|'status'}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/staging-authorize`,{method:'POST',body:{generation,effect}});}
  stagingBuildStatus(runId:string,generation:number,status:import('./staging-build.js').StagingBuildStatus|'discovering'):Promise<{run:Run}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/staging-build-status`,{method:'POST',body:{generation,status}});}
  stagingBuildReceipt(runId:string,generation:number,receipt:Omit<import('./staging-build.js').StagingBuildReceipt,'verifiedAt'>):Promise<{run:Run;artifact:Artifact}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/staging-build-receipt`,{method:'POST',body:{generation,receipt}});}
  stagingProgress(runId:string,generation:number,receipt:import('./staging-deploy.js').StagingReceipt):Promise<{run:Run;artifact:Artifact}>{return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/staging-progress`,{method:'POST',body:{generation,receipt}});}

  pauseState(runId: string): Promise<Run> { return this.readRun(runId); }

  stopped(runId: string, generation: number, threadId?: string): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/stopped`, {
      method: 'POST', body: { generation, ...(threadId ? { threadId } : {}) },
    });
  }

  createBridgeToken(runId: string, generation: number): Promise<{ token: string; expiresAt: string }> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/bridge-token`, { method: 'POST', body: { generation } });
  }

  complete(runId: string, generation: number, details: { threadId?: string; error?: string }): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/complete`, {
      method: 'POST', body: { generation, ...details },
    });
  }

  tool(runId: string, generation: number, action: string, input: Record<string, unknown>, requestId: string): Promise<unknown> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/tools`, {
      method: 'POST', body: { generation, action, input, requestId },
    });
  }

  private async request<T = unknown>(path: string, options: {
    method: string;
    body?: unknown;
    allowNoContent?: boolean;
  }): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 204 && options.allowNoContent) return undefined as T;
    const payload = await response.json().catch(() => undefined) as { message?: unknown; issues?: unknown } | undefined;
    if (!response.ok) {
      const issues = Array.isArray(payload?.issues) ? payload.issues.flatMap((item: any) => {
        if (!item || typeof item !== 'object') return [];
        const path = Array.isArray(item.path) ? item.path.map((part: unknown) => String(part).slice(0, 80)).join('.').slice(0, 200) : '';
        const code = typeof item.code === 'string' ? item.code.slice(0, 80) : '';
        return path && code ? [{ path, code }] : [];
      }).slice(0, 8) : [];
      const summary = typeof payload?.message === 'string' ? payload.message.slice(0, 500) : `Workbench connector request failed (${response.status})`;
      const detail = issues.length ? ` (${issues.map(item => `${item.path}:${item.code}`).join(', ')})` : '';
      const method = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(options.method.toUpperCase()) ? options.method.toUpperCase() : 'OTHER';
      throw new ConnectorHttpError(response.status, `${summary}${detail}`.slice(0, 900), issues, method, routeCategory(path), retryAfterSeconds(response.headers.get('retry-after')));
    }
    const validated = validateResponse(path, payload);
    return validated as T;
  }
}

const provenanceFields = { provenance:z.string().optional(), sourceUrl:z.string().optional(), requestedRef:z.string().optional(), resolvedSha:z.string().optional(), sourcePath:z.string().optional(), contentSha256:z.string().regex(/^[a-f0-9]{64}$/u).optional(), sourceContentSha256:z.string().regex(/^[a-f0-9]{64}$/u).optional(), catalogUrl:z.string().optional(), catalogResolvedSha:z.string().optional() };
const executionSchema = z.object({
  provider: z.literal('openai'), method: z.literal('codex-host'), profileId: z.string().optional(),
  profile:z.object({id:z.string(),name:z.string(),data:z.record(z.string(),z.unknown())}).strict().optional(),
  connectionId:z.string().optional(),connectorId:z.string().optional(),model:z.string().optional(),legacy:z.boolean().optional(),tools: z.array(z.string()),
  skills: z.array(z.object({ id: z.string().min(1), name: z.string(), content: z.string().max(64000),
    ...provenanceFields, copiedFrom:z.object({settingId:z.string(),projectId:z.string(),...provenanceFields,catalogName:z.string().optional(),pluginName:z.string().optional(),includedReferences:z.array(z.string()).optional(),bundleSha256:z.string().optional()}).strict().optional(),
    bundle: z.custom<SkillBundle>(value => { try { verifyBundle(value); return true; } catch { return false; } }).optional()
  }).strict()).max(40)
}).strict();

function validateResponse(path: string, value: unknown): unknown {
  if(path.endsWith('/recovery-state'))return z.object({id:z.string().min(1),generation:z.number().int().positive(),status:z.enum(['queued','running','paused','cancelled','interrupted','completed','failed']),stoppedAt:z.string().optional(),preEffectStaging:z.boolean(),stagingRetired:z.boolean(),merged:z.boolean(),qaResourcePolicy:z.object({resource:qaResource.optional(),providerResource:qaResource.optional()}).strict().optional()}).strict().parse(value);
  if (path.endsWith('/claim')) {
    const claim = z.object({ run: z.object({ id: z.string(), generation: z.number(), model: z.string(), reasoning: z.string(), kind: z.enum(['master','implementation','review','delivery']), status: z.string(), execution: executionSchema.optional() }).passthrough(), execution: executionSchema.optional(), project: z.object({ id: z.string(), repositoryUrl: z.string().optional() }).passthrough(), messages: z.array(z.object({ id: z.string(), role: z.string(), speaker: z.string(), text: z.string(), createdAt: z.string() }).passthrough()), settings: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough()) }).parse(value);
    if (claim.run.execution) verifyExecutionSkills(claim.run.execution.skills);
    if (claim.execution) verifyExecutionSkills(claim.execution.skills);
    if (claim.run.execution && claim.execution && !isDeepStrictEqual(claim.run.execution, claim.execution)) throw new Error('Claim execution snapshot mismatch');
    return claim;
  }
  if (path.endsWith('/bridge-token')) return z.object({ token: z.string().min(32), expiresAt: z.string() }).parse(value);
  if (path.endsWith('/events')) return z.object({ accepted: z.boolean() }).parse(value);
  if (path.endsWith('/tools')) return z.record(z.string(), z.unknown()).parse(value);
  if (path.includes('/artifacts')) return z.object({ id: z.string(), kind: z.enum(['diff','diff_file_chunk','qa','delivery','source']), revision: z.string(), data: z.unknown() }).passthrough().parse(value);
  if (path.endsWith('/qa-authorize')) return z.object({authorized:z.literal(true)}).strict().parse(value);
  if (path.endsWith('/delivery-authorize')) return z.object({ authorized: z.literal(true), repositoryUrl: z.string().url() }).parse(value);
  if (path.endsWith('/delivery-progress')) return z.object({
    run: z.object({ id: z.string(), status: z.string(), generation: z.number() }).passthrough(),
    artifact: z.object({ id: z.string(), kind: z.literal('delivery'), revision: z.string(), data: z.unknown() }).passthrough(),
  }).parse(value);
  if (path.endsWith('/staging-authorize')) return z.object({authorized:z.literal(true),action:z.enum(['discover','deploy','rollback','status'])}).strict().parse(value);
  if (path.endsWith('/staging-build-status')) return z.object({run:z.object({id:z.string(),status:z.string(),generation:z.number()}).passthrough()}).strict().parse(value);
  if (path.endsWith('/staging-build-receipt')) return z.object({run:z.object({id:z.string(),status:z.string(),generation:z.number()}).passthrough(),artifact:z.object({id:z.string(),kind:z.literal('delivery'),revision:z.string(),data:z.unknown()}).passthrough()}).strict().parse(value);
  if (path.endsWith('/staging-progress')) return z.object({
    run: z.object({ id: z.string(), status: z.string(), generation: z.number() }).passthrough(),
    artifact: z.object({ id: z.string(), kind: z.literal('delivery'), revision: z.string(), data: z.unknown() }).passthrough(),
  }).parse(value);
  if (path.includes('/runs/')) return z.object({ id: z.string(), status: z.string(), generation: z.number() }).passthrough().parse(value);
  return value;
}
