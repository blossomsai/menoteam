import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export type AgentHarness = 'codex' | 'hermes';

export interface AgentEndpointConfig {
  id: string;
  label: string;
  harness: AgentHarness;
  tokenSha256: string;
}

export interface SlackOrigin {
  channelId: string;
  threadTs: string;
}

export interface AgentJob {
  id: string;
  prompt: string;
  origin: SlackOrigin;
  createdAt: string;
}

export interface AgentReply {
  endpoint: Omit<AgentEndpointConfig, 'tokenSha256'>;
  job: AgentJob;
  status: 'completed' | 'failed';
  text?: string;
}

export interface AgentEndpointSummary {
  id: string;
  label: string;
  harness: AgentHarness;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
}

export class GatewayError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'OFFLINE' | 'CONFLICT' | 'INVALID_ORIGIN',
    message: string,
  ) {
    super(message);
  }
}

interface Waiter {
  resolve: (job: AgentJob | null) => void;
  timer: NodeJS.Timeout;
}

interface PendingJob {
  endpointId: string;
  job: AgentJob;
  expiresAt: number;
}

export interface AgentRouterOptions {
  allowedSlackChannels: string[];
  onlineWindowMs?: number;
  jobTtlMs?: number;
  now?: () => number;
  onReply: (reply: AgentReply) => Promise<void>;
}

export class AgentRouter {
  private readonly endpoints = new Map<string, AgentEndpointConfig>();
  private readonly queues = new Map<string, AgentJob[]>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly lastSeen = new Map<string, number>();
  private readonly allowedSlackChannels: Set<string>;
  private readonly onlineWindowMs: number;
  private readonly jobTtlMs: number;
  private readonly now: () => number;
  private readonly onReply: (reply: AgentReply) => Promise<void>;

  constructor(configs: AgentEndpointConfig[], options: AgentRouterOptions) {
    const tokenDigests = new Set<string>();
    for (const config of configs) {
      if (this.endpoints.has(config.id)) throw new Error(`Duplicate agent endpoint: ${config.id}`);
      if (tokenDigests.has(config.tokenSha256)) throw new Error('Agent endpoint tokens must be distinct');
      tokenDigests.add(config.tokenSha256);
      this.endpoints.set(config.id, config);
      this.queues.set(config.id, []);
    }
    this.allowedSlackChannels = new Set(options.allowedSlackChannels);
    this.onlineWindowMs = options.onlineWindowMs ?? 45_000;
    this.jobTtlMs = options.jobTtlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.onReply = options.onReply;
  }

  authenticate(endpointId: string, authorization: string | undefined): void {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) throw new GatewayError('NOT_FOUND', 'Agent endpoint not found');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    const tokenHash = token ? createHash('sha256').update(token).digest('hex') : undefined;
    if (!secretMatches(tokenHash, endpoint.tokenSha256)) {
      throw new GatewayError('UNAUTHORIZED', 'Unauthorized');
    }
  }

  addEndpoint(config: AgentEndpointConfig): void {
    if (this.endpoints.has(config.id)) throw new Error(`Duplicate agent endpoint: ${config.id}`);
    if ([...this.endpoints.values()].some(({ tokenSha256 }) => tokenSha256 === config.tokenSha256)) {
      throw new Error('Agent endpoint tokens must be distinct');
    }
    this.endpoints.set(config.id, { ...config });
    this.queues.set(config.id, []);
  }

  renameEndpoint(endpointId: string, label: string): void {
    const endpoint = this.requireEndpoint(endpointId);
    this.endpoints.set(endpointId, { ...endpoint, label });
  }

  removeEndpoint(endpointId: string): void {
    this.requireEndpoint(endpointId);
    const waiter = this.waiters.get(endpointId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
      this.waiters.delete(endpointId);
    }
    for (const [jobId, pending] of this.pending) {
      if (pending.endpointId === endpointId) this.pending.delete(jobId);
    }
    this.endpoints.delete(endpointId);
    this.queues.delete(endpointId);
    this.lastSeen.delete(endpointId);
  }

  listEndpoints(): AgentEndpointSummary[] {
    this.pruneExpiredJobs();
    return [...this.endpoints.values()].map((endpoint) => {
      const lastSeen = this.lastSeen.get(endpoint.id);
      const hasPendingJob = [...this.pending.values()].some((pending) => pending.endpointId === endpoint.id);
      return {
        id: endpoint.id,
        label: endpoint.label,
        harness: endpoint.harness,
        status: hasPendingJob || (lastSeen !== undefined && this.now() - lastSeen <= this.onlineWindowMs) ? 'online' : 'offline',
        lastSeenAt: lastSeen === undefined ? null : new Date(lastSeen).toISOString(),
      };
    });
  }

  waitForJob(endpointId: string, waitMs: number): Promise<AgentJob | null> {
    this.requireEndpoint(endpointId);
    this.pruneExpiredJobs();
    this.lastSeen.set(endpointId, this.now());
    const queued = this.queues.get(endpointId)?.shift();
    if (queued) return Promise.resolve(queued);
    if (this.waiters.has(endpointId)) {
      throw new GatewayError('CONFLICT', 'Another connector is already polling for this endpoint');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(endpointId);
        this.lastSeen.set(endpointId, this.now());
        resolve(null);
      }, waitMs);
      timer.unref();
      this.waiters.set(endpointId, { resolve, timer });
    });
  }

  route(endpointId: string, prompt: string, origin: SlackOrigin): AgentJob {
    this.requireEndpoint(endpointId);
    this.pruneExpiredJobs();
    if (!this.allowedSlackChannels.has(origin.channelId)) {
      throw new GatewayError('INVALID_ORIGIN', 'Slack channel is not allowlisted');
    }
    if ([...this.pending.values()].some((pending) => pending.endpointId === endpointId)) {
      throw new GatewayError('CONFLICT', 'Agent endpoint is busy');
    }
    const lastSeen = this.lastSeen.get(endpointId);
    if (lastSeen === undefined || this.now() - lastSeen > this.onlineWindowMs) {
      throw new GatewayError('OFFLINE', 'Agent endpoint is offline');
    }
    const job: AgentJob = {
      id: randomUUID(),
      prompt,
      origin,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.pending.set(job.id, { endpointId, job, expiresAt: this.now() + this.jobTtlMs });
    const waiter = this.waiters.get(endpointId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(endpointId);
      waiter.resolve(job);
    } else {
      this.queues.get(endpointId)?.push(job);
    }
    return job;
  }

  async reply(endpointId: string, jobId: string, status: 'completed' | 'failed', text?: string): Promise<void> {
    this.requireEndpoint(endpointId);
    this.pruneExpiredJobs();
    const pending = this.pending.get(jobId);
    if (!pending) throw new GatewayError('NOT_FOUND', 'Job not found');
    if (pending.endpointId !== endpointId) throw new GatewayError('UNAUTHORIZED', 'Job belongs to another endpoint');
    const endpoint = this.endpoints.get(endpointId)!;
    await this.onReply({
      endpoint: { id: endpoint.id, label: endpoint.label, harness: endpoint.harness },
      job: pending.job,
      status,
      text,
    });
    this.pending.delete(jobId);
    this.lastSeen.set(endpointId, this.now());
  }

  close(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.clear();
  }

  private requireEndpoint(endpointId: string): AgentEndpointConfig {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) throw new GatewayError('NOT_FOUND', 'Agent endpoint not found');
    return endpoint;
  }

  private pruneExpiredJobs(): void {
    const now = this.now();
    for (const [jobId, pending] of this.pending) {
      if (pending.expiresAt > now) continue;
      this.pending.delete(jobId);
      const queue = this.queues.get(pending.endpointId);
      const queuedIndex = queue?.findIndex((job) => job.id === jobId) ?? -1;
      if (queue && queuedIndex >= 0) queue.splice(queuedIndex, 1);
    }
  }
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
