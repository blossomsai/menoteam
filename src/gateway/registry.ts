import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentEndpointConfig, AgentHarness } from './router.js';

export const endpointLabelSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{M}\p{N} .,'’()+/·-]+$/u, 'label contains unsupported characters');

const endpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
  label: endpointLabelSchema,
  harness: z.enum(['codex', 'hermes']),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workMapTokenSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

const pairingSchema = z.object({
  id: z.string().uuid(),
  userCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u),
  deviceCodeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  connectorTokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  workMapTokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  label: endpointLabelSchema,
  harness: z.literal('codex'),
  status: z.enum(['pending', 'approved', 'rejected']),
  endpointId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u).optional(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict();

const stateSchema = z.object({
  version: z.literal(1),
  pairedEndpoints: endpointSchema.array().max(500),
  pairings: pairingSchema.array().max(500),
}).strict();

export interface GatewayEndpointRecord extends AgentEndpointConfig {
  workMapTokenSha256?: string;
}

export interface StoredPairing {
  id: string;
  userCode: string;
  deviceCodeSha256: string;
  connectorTokenSha256: string;
  workMapTokenSha256: string;
  label: string;
  harness: Extract<AgentHarness, 'codex'>;
  status: 'pending' | 'approved' | 'rejected';
  endpointId?: string;
  createdAt: number;
  expiresAt: number;
}

interface GatewayState {
  version: 1;
  pairedEndpoints: GatewayEndpointRecord[];
  pairings: StoredPairing[];
}

export class GatewayRegistry {
  private readonly staticEndpoints: GatewayEndpointRecord[];
  private state: GatewayState;
  private mutation = Promise.resolve();

  private constructor(seed: GatewayEndpointRecord[], state: GatewayState, private readonly filePath?: string) {
    this.staticEndpoints = seed.map((record) => ({ ...record }));
    this.state = cloneState(state);
    validateRecords([...this.staticEndpoints, ...this.state.pairedEndpoints]);
    validatePairings(this.state.pairings);
  }

  static async open(seed: GatewayEndpointRecord[], filePath?: string): Promise<GatewayRegistry> {
    validateRecords(seed);
    if (!filePath) return new GatewayRegistry(seed, emptyState());
    const path = resolve(filePath);
    let state = emptyState();
    try {
      state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('AGENT_GATEWAY_REGISTRY_FILE is invalid', { cause: error });
    }
    const registry = new GatewayRegistry(seed, state, path);
    if (!state.pairedEndpoints.length && !state.pairings.length) await registry.persist();
    return registry;
  }

  connectorConfigs(): AgentEndpointConfig[] {
    return this.allEndpoints().map(({ workMapTokenSha256: _workMapTokenSha256, ...config }) => ({ ...config }));
  }

  list(): GatewayEndpointRecord[] {
    return this.allEndpoints().map((record) => ({ ...record }));
  }

  managedEndpointIds(): string[] {
    return this.state.pairedEndpoints.map(({ id }) => id);
  }

  listPairings(): StoredPairing[] {
    return this.state.pairings.map((pairing) => ({ ...pairing }));
  }

  async addPairing(pairing: StoredPairing): Promise<void> {
    await this.mutate((state) => {
      validatePairings([...state.pairings, pairing]);
      state.pairings.push({ ...pairing });
    });
  }

  async prunePairings(expiredBefore: number): Promise<void> {
    if (!this.state.pairings.some(({ expiresAt }) => expiresAt < expiredBefore)) return;
    await this.mutate((state) => {
      state.pairings = state.pairings.filter(({ expiresAt }) => expiresAt >= expiredBefore);
    });
  }

  async approvePairing(pairingId: string, endpoint: GatewayEndpointRecord): Promise<void> {
    await this.mutate((state) => {
      const pairing = state.pairings.find(({ id }) => id === pairingId);
      if (!pairing) throw new Error('Pairing request not found');
      if (pairing.status !== 'pending') throw new Error('Pairing request is no longer pending');
      validateRecords([...this.staticEndpoints, ...state.pairedEndpoints, endpoint]);
      pairing.status = 'approved';
      pairing.endpointId = endpoint.id;
      state.pairedEndpoints.push({ ...endpoint });
    });
  }

  async rejectPairing(pairingId: string): Promise<void> {
    await this.mutate((state) => {
      const pairing = state.pairings.find(({ id }) => id === pairingId);
      if (!pairing) throw new Error('Pairing request not found');
      if (pairing.status !== 'pending') throw new Error('Pairing request is no longer pending');
      pairing.status = 'rejected';
    });
  }

  async rename(id: string, label: string): Promise<void> {
    await this.mutate((state) => {
      const record = state.pairedEndpoints.find((endpoint) => endpoint.id === id);
      if (!record) throw new Error('Only paired endpoints can be renamed here');
      record.label = label;
      validateRecords([...this.staticEndpoints, ...state.pairedEndpoints]);
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      const remaining = state.pairedEndpoints.filter((record) => record.id !== id);
      if (remaining.length === state.pairedEndpoints.length) throw new Error('Only paired endpoints can be revoked here');
      state.pairedEndpoints = remaining;
    });
  }

  authenticateWorkMap(authorization: string | undefined): GatewayEndpointRecord {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    const digest = token ? createHash('sha256').update(token).digest('hex') : undefined;
    const record = this.state.pairedEndpoints.find(({ workMapTokenSha256 }) => secretMatches(digest, workMapTokenSha256));
    if (!record) throw new Error('Unauthorized');
    return { ...record };
  }

  private allEndpoints(): GatewayEndpointRecord[] {
    return [...this.staticEndpoints, ...this.state.pairedEndpoints];
  }

  private async mutate(change: (state: GatewayState) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const candidate = cloneState(this.state);
      change(candidate);
      validateRecords([...this.staticEndpoints, ...candidate.pairedEndpoints]);
      validatePairings(candidate.pairings);
      const previous = this.state;
      this.state = candidate;
      try {
        await this.persist();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    });
    this.mutation = operation.catch(() => undefined);
    await operation;
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.filePath), 0o700);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

function emptyState(): GatewayState {
  return { version: 1, pairedEndpoints: [], pairings: [] };
}

function cloneState(state: GatewayState): GatewayState {
  return {
    version: 1,
    pairedEndpoints: state.pairedEndpoints.map((record) => ({ ...record })),
    pairings: state.pairings.map((pairing) => ({ ...pairing })),
  };
}

function validateRecords(records: GatewayEndpointRecord[]): void {
  endpointSchema.array().min(1).max(500).parse(records);
  if (new Set(records.map(({ id }) => id)).size !== records.length) throw new Error('Agent endpoint IDs must be distinct');
  const digests = records.flatMap(({ tokenSha256, workMapTokenSha256 }) => [tokenSha256, workMapTokenSha256].filter((value): value is string => Boolean(value)));
  if (new Set(digests).size !== digests.length) throw new Error('Agent endpoint credentials must be distinct');
}

function validatePairings(pairings: StoredPairing[]): void {
  pairingSchema.array().max(500).parse(pairings);
  if (new Set(pairings.map(({ id }) => id)).size !== pairings.length) throw new Error('Pairing IDs must be distinct');
  if (new Set(pairings.map(({ userCode }) => userCode)).size !== pairings.length) throw new Error('Pairing user codes must be distinct');
}

function secretMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
