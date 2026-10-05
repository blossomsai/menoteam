export interface Member {
    id: string;
    email: string;
    name: string;
    role: 'owner' | 'admin' | 'member';
}
export interface Project {
    id: string;
    name: string;
    instructions: string;
    repositoryUrl: string;
    deliveryAuthorization: string;
    feedbackIntake?: {enabled:boolean;allowExecution:boolean;actorId:string};
    createdAt: string;
}
export interface Work {
    id: string;
    projectId: string;
    title: string;
    overview: string;
    status: 'queued' | 'in_progress' | 'paused' | 'done';
    revision: number;
    profileId: string;
    sources: string[];
    createdAt: string;
    updatedAt: string;
}
export interface Message {
    id: string;
    projectId: string;
    workId?: string;
    speaker: string;
    role: 'user' | 'master' | 'agent' | 'subagent';
    text: string;
    runId?: string;
    createdAt: string;
}
export interface Run {
    id: string;
    projectId: string;
    workId?: string;
    prompt: string;
    requestedBy?: string;
    allowedActions?: string[];
    sourceIds?: string[];
    execution?: ExecutionContext;
    kind: 'master' | 'implementation' | 'review' | 'delivery';
    operation?: {
        action: 'create_draft_pr';
        actorId: string;
        candidateRunId: string;
        candidateRevision: string;
        artifactRevision: string;
        commitSha: string;
        candidateFingerprint: string;
        baseRevision: string;
        baseBranch: string;
        remoteBranch: string;
        workTitle: string;
        changeSummary: string;
        qaStatus: string;
        phase: 'queued' | 'published' | 'pr_created';
        external?: { pullRequestNumber?: number; pullRequestUrl?: string; headSha?: string };
    };
    model: string;
    reasoning: string;
    status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    threadId?: string;
    targetRevision?: string;
    targetRunId?: string;
    targetConnectorId?: string;
    connectorId?: string;
    generation: number;
    leaseUntil?: string;
    stoppedAt?: string;
    createdAt: string;
    updatedAt: string;
    error?: string;
}
export interface Artifact {
    id: string;
    projectId: string;
    workId?: string;
    runId: string;
    kind: 'diff' | 'qa' | 'delivery' | 'source';
    revision: string;
    data?: unknown;
    createdAt: string;
}
export interface RunEvent {
    id: string;
    runId: string;
    projectId: string;
    sequence: number;
    type: string;
    text: string;
    createdAt: string;
}
export interface Setting {
    id: string;
    kind: 'profile' | 'provider' | 'skill' | 'connection';
    projectId?: string;
    name: string;
    data: Record<string, unknown>;
    updatedAt: string;
}

export interface ExecutionContext {
    profileId?: string;
    provider: 'openai';
    method: 'codex-host';
    skills: Array<{id:string;name:string;content:string}>;
    tools: string[];
}
export interface RuntimeProvider {
    provider: 'openai';
    method: 'codex-host';
    connectorId: string;
    available: boolean;
    models: string[];
    lastSeen: string;
    verifiedRunId?: string;
    verifiedAt?: string;
}
