import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentEndpointSummary, AgentHarness, AgentRouter } from './router.js';
import { GatewayRegistry, type GatewayEndpointRecord, type StoredPairing } from './registry.js';

export interface PairingSummary {
  id: string;
  user_code: string;
  label: string;
  harness: Extract<AgentHarness, 'codex'>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  endpoint_id?: string;
  created_at: string;
  expires_at: string;
}

export class PairingError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'EXPIRED' | 'PENDING' | 'REJECTED' | 'CONFLICT', message: string) {
    super(message);
  }
}

export interface PairingManagerOptions {
  gatewayUrl: string;
  workMapUrl: string;
  ttlMs?: number;
  now?: () => number;
}

export class PairingManager {
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly registry: GatewayRegistry,
    private readonly router: AgentRouter,
    private readonly options: PairingManagerOptions,
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async create(input: {
    label: string;
    harness: Extract<AgentHarness, 'codex'>;
    connectorTokenSha256: string;
    workMapTokenSha256: string;
    deviceCode: string;
  }): Promise<{
    pairing_id: string;
    user_code: string;
    verification_url: string;
    expires_at: string;
    interval_seconds: number;
  }> {
    const deviceCodeSha256 = sha256(input.deviceCode);
    const existing = this.registry.listPairings().find((pairing) => pairing.deviceCodeSha256 === deviceCodeSha256 && pairing.expiresAt > this.now());
    if (existing) {
      if (existing.label !== input.label || existing.connectorTokenSha256 !== input.connectorTokenSha256 || existing.workMapTokenSha256 !== input.workMapTokenSha256) {
        throw new PairingError('CONFLICT', 'Pairing retry does not match the original request');
      }
      return responseFor(existing, this.options.gatewayUrl);
    }
    await this.registry.prunePairings(this.now() - 24 * 60 * 60_000);
    const active = this.registry.listPairings().filter((pairing) => pairing.status === 'pending' && pairing.expiresAt > this.now());
    if (active.length >= 100) throw new PairingError('CONFLICT', 'Too many pairing requests are waiting');
    if (new Set([input.connectorTokenSha256, input.workMapTokenSha256, deviceCodeSha256]).size !== 3) {
      throw new PairingError('CONFLICT', 'Pairing credentials must be distinct');
    }
    const now = this.now();
    const pairing: StoredPairing = {
      id: randomUUID(),
      userCode: uniqueUserCode(new Set(this.registry.listPairings().map(({ userCode }) => userCode))),
      deviceCodeSha256,
      connectorTokenSha256: input.connectorTokenSha256,
      workMapTokenSha256: input.workMapTokenSha256,
      label: input.label,
      harness: input.harness,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    await this.registry.addPairing(pairing);
    return responseFor(pairing, this.options.gatewayUrl);
  }

  listPairings(): PairingSummary[] {
    const now = this.now();
    return this.registry.listPairings().map((pairing) => ({
      id: pairing.id,
      user_code: pairing.userCode,
      label: pairing.label,
      harness: pairing.harness,
      status: pairing.expiresAt <= now ? 'expired' : pairing.status,
      ...(pairing.endpointId ? { endpoint_id: pairing.endpointId } : {}),
      created_at: new Date(pairing.createdAt).toISOString(),
      expires_at: new Date(pairing.expiresAt).toISOString(),
    }));
  }

  listEndpoints(): AgentEndpointSummary[] {
    return this.router.listEndpoints();
  }

  managedEndpointIds(): string[] {
    return this.registry.managedEndpointIds();
  }

  async approve(pairingId: string, input: { label?: string; endpointId?: string } = {}): Promise<void> {
    const pairing = this.requirePending(pairingId);
    const label = input.label?.trim() || pairing.label;
    const endpointId = input.endpointId || availableEndpointId(label, this.registry.list());
    const record: GatewayEndpointRecord = {
      id: endpointId,
      label,
      harness: pairing.harness,
      tokenSha256: pairing.connectorTokenSha256,
      workMapTokenSha256: pairing.workMapTokenSha256,
    };
    try {
      this.router.addEndpoint(record);
    } catch (error) {
      throw new PairingError('CONFLICT', error instanceof Error ? error.message : 'Endpoint could not be added');
    }
    try {
      await this.registry.approvePairing(pairingId, record);
    } catch (error) {
      this.router.removeEndpoint(endpointId);
      throw new PairingError('CONFLICT', error instanceof Error ? error.message : 'Endpoint could not be persisted');
    }
  }

  async reject(pairingId: string): Promise<void> {
    this.requirePending(pairingId);
    await this.registry.rejectPairing(pairingId);
  }

  poll(pairingId: string, authorization: string | undefined): {
    status: 'approved';
    endpoint_id: string;
    endpoint_label: string;
    work_map_url: string;
  } {
    const pairing = this.registry.listPairings().find(({ id }) => id === pairingId);
    if (!pairing) throw new PairingError('NOT_FOUND', 'Pairing request not found');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (!secretMatches(token ? sha256(token) : undefined, pairing.deviceCodeSha256)) throw new PairingError('UNAUTHORIZED', 'Unauthorized');
    if (pairing.expiresAt <= this.now()) throw new PairingError('EXPIRED', 'Pairing request expired');
    if (pairing.status === 'pending') throw new PairingError('PENDING', 'Pairing request is waiting for approval');
    if (pairing.status === 'rejected') throw new PairingError('REJECTED', 'Pairing request was rejected');
    if (!pairing.endpointId) throw new PairingError('CONFLICT', 'Approved pairing is missing its endpoint');
    return { status: 'approved', endpoint_id: pairing.endpointId, endpoint_label: pairing.label, work_map_url: this.options.workMapUrl };
  }

  async renameEndpoint(endpointId: string, label: string): Promise<void> {
    try {
      await this.registry.rename(endpointId, label);
    } catch (error) {
      throw new PairingError('CONFLICT', error instanceof Error ? error.message : 'Endpoint could not be renamed');
    }
    this.router.renameEndpoint(endpointId, label);
  }

  async revokeEndpoint(endpointId: string): Promise<void> {
    try {
      await this.registry.remove(endpointId);
    } catch (error) {
      throw new PairingError('CONFLICT', error instanceof Error ? error.message : 'Endpoint could not be revoked');
    }
    this.router.removeEndpoint(endpointId);
  }

  private requirePending(pairingId: string): StoredPairing {
    const pairing = this.registry.listPairings().find(({ id }) => id === pairingId);
    if (!pairing) throw new PairingError('NOT_FOUND', 'Pairing request not found');
    if (pairing.expiresAt <= this.now()) throw new PairingError('EXPIRED', 'Pairing request expired');
    if (pairing.status !== 'pending') throw new PairingError('CONFLICT', 'Pairing request is no longer pending');
    return pairing;
  }
}

function availableEndpointId(label: string, records: GatewayEndpointRecord[]): string {
  const base = label.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'codex-agent';
  const normalized = base.length >= 2 ? base : `${base}-agent`;
  const ids = new Set(records.map(({ id }) => id));
  if (!ids.has(normalized)) return normalized;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${normalized.slice(0, 62 - String(suffix).length - 1)}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate an endpoint ID');
}

function responseFor(pairing: StoredPairing, gatewayUrl: string) {
  return {
    pairing_id: pairing.id,
    user_code: pairing.userCode,
    verification_url: `${gatewayUrl}/agents`,
    expires_at: new Date(pairing.expiresAt).toISOString(),
    interval_seconds: 2,
  };
}

function uniqueUserCode(existing: Set<string>): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    const raw = [...randomBytes(8)].map((value) => alphabet[value % alphabet.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!existing.has(code)) return code;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
