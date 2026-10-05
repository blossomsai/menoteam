import type { Artifact, Run } from '../workbench/types.js';
import type { ClaimedRun, ConnectorEvent, ConnectorConfig, UploadArtifact } from './types.js';
import { z } from 'zod';

export class ConnectorHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export class WorkbenchConnectorClient {
  private readonly baseUrl: string;
  private readonly codexModels: string[];

  constructor(private readonly config: Pick<ConnectorConfig, 'serverUrl' | 'token'>, private readonly fetcher: typeof fetch = fetch, codexModels: string[] = []) {
    const url = new URL(config.serverUrl);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('Workbench connector URL must use HTTPS except on localhost');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('Workbench connector URL must not contain credentials or query parameters');
    this.baseUrl = url.toString().replace(/\/$/u, '');
    this.codexModels = [...new Set(codexModels)];
  }

  async claim(): Promise<ClaimedRun | undefined> {
    const result = await this.request<ClaimedRun | undefined>('/api/workbench/connector/claim', {
      method: 'POST', body: { capabilities: { codexAppServer: true, models: this.codexModels, localWorktrees: true } },
      allowNoContent: true,
    });
    return result;
  }

  renew(runId: string, generation: number): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/renew`, { method: 'POST', body: { generation } });
  }

  readRun(runId: string): Promise<Run> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}`, { method: 'GET' });
  }

  appendEvents(runId: string, generation: number, events: ConnectorEvent[]): Promise<{ accepted: boolean }> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/events`, { method: 'POST', body: { generation, events } });
  }

  addArtifact(runId: string, generation: number, artifact: UploadArtifact): Promise<Artifact> {
    return this.request(`/api/workbench/connector/runs/${encodeURIComponent(runId)}/artifacts`, {
      method: 'POST', body: { generation, ...artifact },
    });
  }

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
    const payload = await response.json().catch(() => undefined) as { message?: unknown } | undefined;
    if (!response.ok) throw new ConnectorHttpError(response.status,
      typeof payload?.message === 'string' ? payload.message.slice(0, 500) : `Workbench connector request failed (${response.status})`);
    const validated = validateResponse(path, payload);
    return validated as T;
  }
}

function validateResponse(path: string, value: unknown): unknown {
  if (path.endsWith('/claim')) {
    return z.object({ run: z.object({ id: z.string(), generation: z.number(), model: z.string(), reasoning: z.string(), kind: z.enum(['master','implementation','review']), status: z.string() }).passthrough(), project: z.object({ id: z.string(), repositoryUrl: z.string().optional() }).passthrough(), messages: z.array(z.object({ id: z.string(), role: z.string(), speaker: z.string(), text: z.string(), createdAt: z.string() }).passthrough()), settings: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string(), data: z.record(z.string(), z.unknown()) }).passthrough()) }).parse(value);
  }
  if (path.endsWith('/bridge-token')) return z.object({ token: z.string().min(32), expiresAt: z.string() }).parse(value);
  if (path.endsWith('/events')) return z.object({ accepted: z.boolean() }).parse(value);
  if (path.endsWith('/tools')) return z.record(z.string(), z.unknown()).parse(value);
  if (path.includes('/artifacts')) return z.object({ id: z.string(), kind: z.enum(['diff','qa','delivery','source']), revision: z.string(), data: z.unknown() }).passthrough().parse(value);
  if (path.includes('/runs/')) return z.object({ id: z.string(), status: z.string(), generation: z.number() }).passthrough().parse(value);
  return value;
}
