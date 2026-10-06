import type { Artifact, Member, Message, Project, Run, RuntimeProvider, Setting, Work } from '../types';

export interface Snapshot {
  member: Member;
  projects: Project[];
  works: Work[];
  messages: Message[];
  runs: Run[];
  artifacts: Artifact[];
  settings: Setting[];
  runtimeProviders: RuntimeProvider[];
  providerConnections?: ProviderConnection[];
  projectRoles?: Record<string, Member['role']>;
}

export interface ProviderConnection {
  id: string;
  name: string;
  connectorId?: string;
  enabled: boolean;
  default: boolean;
  status: 'disabled' | 'unbound' | 'disconnected' | 'offline' | 'capability_unavailable' | 'available' | string;
  models: string[];
  projectIds: string[];
  runKinds?: string[];
  localWorktrees?: boolean;
  reason?: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/workbench${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null;
    throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export const workbenchApi = {
  me: () => request<Member>('/me'),
  login: (email: string, password: string) => request<{ authenticated: true }>('/session', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/logout', { method: 'POST' }),
  snapshot: () => request<Snapshot>('/snapshot'),
  artifact: (id: string) => request<Artifact>(`/artifacts/${encodeURIComponent(id)}`),
  projectMessages: (projectId: string, query: { workId?: string; before?: string; after?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.workId) params.set('workId', query.workId);
    if (query.before) params.set('before', query.before);
    if (query.after) params.set('after', query.after);
    return request<{ messages: Message[]; nextBefore: string | null }>(`/projects/${encodeURIComponent(projectId)}/messages${params.size ? `?${params}` : ''}`);
  },
  projectMembers: (projectId: string) => request<{ members: Member[] }>(`/projects/${encodeURIComponent(projectId)}/members`),
  removeProjectMember: (projectId: string, userId: string) => request<{ removed: true }>(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  projectInvites: (projectId: string) => request<{ invites: Array<{ id: string; email: string; role: Member['role']; expiresAt: string }> }>(`/projects/${encodeURIComponent(projectId)}/invites`),
  importGithubSkill: (projectId: string, url: string, name?: string) => request<Setting>(`/projects/${encodeURIComponent(projectId)}/skills/import`, { method: 'POST', body: JSON.stringify({ url, ...(name ? { name } : {}) }) }),
  previewCatalogPlugin: (input: { scope: 'project' | 'workspace'; projectId?: string; catalogUrl: string; pluginName: string }) => request<{ catalog: { name: string; url: string; commit: string }; plugin: { name: string; description: string; commit: string; version: string | null }; unsupported: string[]; skills: Array<{ name: string; description: string; license: string | null; path: string; content: string; includedReferences: Array<{ path: string; content: string }>; bundleFiles: Array<{ path: string; mode: string; bytes: number; sha256: string }>; bundleSha256?: string; unsupportedDependency?: string; contentSha256: string }> }>('/skills/catalog/preview', { method: 'POST', body: JSON.stringify(input) }),
  listCatalog: (input: { scope: 'project' | 'workspace'; projectId?: string; catalogUrl: string }) => request<{ name: string; url: string; commit: string; plugins: Array<{ name: string; description: string; category: string; unsupportedReason?: string }> }>('/skills/catalog', { method: 'POST', body: JSON.stringify(input) }),
  importCatalogSkills: (input: { scope: 'project' | 'workspace'; projectId?: string; catalogUrl: string; pluginName: string; selectedPaths: string[]; previewCommit: string; previewCatalogCommit: string }) => request<{ installed: Setting[] }>('/skills/catalog/import', { method: 'POST', body: JSON.stringify(input) }),
  revokeInvite: (inviteId: string) => request<{ revoked: true }>(`/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' }),
  createProject: (input: { name: string; repositoryUrl?: string }) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: { instructions?: string; expectedInstructions?: string; deliveryAuthorization?: string; feedbackIntake?: { enabled: boolean; allowExecution: boolean } }) => request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createWork: (projectId: string, input: { title: string; overview: string; connectionId: string; profileId?: string }) => request<Work>(`/projects/${encodeURIComponent(projectId)}/works`, { method: 'POST', body: JSON.stringify(input) }),
  sendMessage: (projectId: string, input: { text: string; workId?: string; connectionId?: string; requestId: string }) => request<{ message: Message; run: Run }>(`/projects/${encodeURIComponent(projectId)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  updateWork: (workId: string, input: { revision: number; overview?: string; status?: Work['status']; profileId?: string }) => request<Work>(`/works/${encodeURIComponent(workId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  requestDraftPr: (workId: string, input: { candidateRunId: string; candidateRevision: string; action: 'create_draft_pr'; requestId: string }) => request<{ run: Run; operationId: string }>(`/works/${encodeURIComponent(workId)}/delivery`, { method: 'POST', body: JSON.stringify(input) }),
  requestMergePr: (workId: string, input: { priorDeliveryRunId: string; reviewRunId: string; requestId: string }) => request<{ run: Run; operationId: string }>(`/works/${encodeURIComponent(workId)}/merge`, { method: 'POST', body: JSON.stringify(input) }),
  cancelRun: (runId: string) => request<Run>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  pauseRun: (runId: string) => request<Run>(`/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' }),
  resumeRun: (runId: string) => request<Run>(`/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }),
  reconcileRun: (runId: string) => request<Run>(`/runs/${encodeURIComponent(runId)}/reconcile`, { method: 'POST', body: JSON.stringify({ stopped: true }) }),
  saveSetting: (input: { kind: Setting['kind']; projectId?: string; name: string; data: Record<string, unknown> }) => request<Setting>('/settings', { method: 'POST', body: JSON.stringify(input) }),
  updateSetting: (id: string, input: { name?: string; data?: Record<string, unknown>; expectedUpdatedAt?: string }) => request<Setting>(`/settings/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  copyProjectSkill: (id: string) => request<Setting>(`/settings/${encodeURIComponent(id)}/copy-to-workspace`, { method: 'POST', body: '{}' }),
  invite: (input: { email: string; projectId?: string; role: Member['role'] }) => request<{ token: string; expiresAt: string }>('/invites', { method: 'POST', body: JSON.stringify(input) }),
  acceptInvite: (input: { token: string; name: string; password: string }) => request<{ accepted: true; email: string }>('/invites/accept', { method: 'POST', body: JSON.stringify(input) }),
};
