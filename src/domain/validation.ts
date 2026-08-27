import { DomainError, validateMemory, validateRef, validateText } from './errors.js';
import type { AgentAddresses, CreateWorkInput, OwnerEvidence, OwnerSource, TeammateChanges, WorkChanges } from './model.js';

export function validateCreateWork(input: CreateWorkInput): void {
  validateText(input.title, 'title');
  validateRef(input.owner, 'teammate');
  validateOwnerProvenance(input.owner_source, input.owner_evidence);
  validateText(input.current_summary, 'current_summary');
  validateText(input.living_doc_markdown, 'living_doc_markdown');
  validateRefs(input.parent, input.dependencies ?? []);
}

export function validateWorkChanges(changes: WorkChanges): void {
  if (changes.owner !== undefined) validateRef(changes.owner, 'teammate');
  validateOwnerProvenance(changes.owner_source, changes.owner_evidence);
  if (changes.current_summary !== undefined) validateText(changes.current_summary, 'current_summary');
  if (changes.living_doc_markdown !== undefined) validateText(changes.living_doc_markdown, 'living_doc_markdown');
  validateRefs(changes.parent, changes.dependencies ?? []);
}

export function validateOwnerProvenance(source: OwnerSource | undefined, evidence: OwnerEvidence[] | undefined): void {
  if (source !== undefined && source !== 'confirmed' && source !== 'inferred' && source !== 'unresolved') {
    throw new DomainError('VALIDATION', 'owner_source must be confirmed, inferred, or unresolved');
  }
  if (evidence === undefined) return;
  if (!Array.isArray(evidence)) throw new DomainError('VALIDATION', 'owner_evidence must be an array');
  if (evidence.length > 12) throw new DomainError('VALIDATION', 'owner_evidence must contain 12 items or fewer');
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.kind !== 'string' || !item.kind.trim() || typeof item.label !== 'string' || !item.label.trim()) {
      throw new DomainError('VALIDATION', 'Each owner_evidence item requires a kind and label');
    }
    for (const field of ['ref', 'detail', 'url'] as const) {
      if (item[field] !== undefined && typeof item[field] !== 'string') {
        throw new DomainError('VALIDATION', `owner_evidence.${field} must be a string`);
      }
    }
  }
}

export function validateTeammateChanges(changes: TeammateChanges): void {
  if (changes.display_name !== undefined) validateText(changes.display_name, 'display_name');
  if (changes.default_agent_addresses !== undefined) validateAddresses(changes.default_agent_addresses);
  if (changes.memory !== undefined) validateMemory(changes.memory);
}

function validateRefs(parent: string | null | undefined, dependencies: string[]): void {
  if (parent !== undefined && parent !== null) validateRef(parent, 'work');
  const unique = new Set<string>();
  for (const dependency of dependencies) {
    validateRef(dependency, 'work');
    if (unique.has(dependency)) throw new DomainError('VALIDATION', 'dependencies must not contain duplicates');
    unique.add(dependency);
  }
}

function validateAddresses(addresses: AgentAddresses): void {
  for (const [platform, address] of Object.entries(addresses)) {
    if (!platform.trim() || !address.trim()) throw new DomainError('VALIDATION', 'Agent addresses must have non-empty platform and address');
  }
}
