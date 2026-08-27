export type DomainErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'DUPLICATE_IDENTITY';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function asDomainError(error: unknown): DomainError {
  return error instanceof DomainError
    ? error
    : new DomainError('VALIDATION', 'Request failed');
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function validateMemory(memory: string): void {
  if (wordCount(memory) > 200) {
    throw new DomainError('VALIDATION', 'Teammate Memory must be 200 words or fewer', { max_words: 200, actual_words: wordCount(memory) });
  }
}

export function validateRef(ref: string, kind: 'work' | 'teammate'): void {
  const prefix = kind === 'work' ? 'work_' : 'teammate_';
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]+$`, 'u').test(ref)) {
    throw new DomainError('VALIDATION', `Invalid ${kind} reference`);
  }
}

export function validateText(value: string, field: string): void {
  if (!value.trim()) throw new DomainError('VALIDATION', `${field} cannot be empty`);
}
