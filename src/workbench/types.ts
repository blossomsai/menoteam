import type { SkillBundle } from './skill-bundle-types.js';
import type { QaPolicy } from './local-qa.js';
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
    connectionId?: string;
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
    causedByRunId?: string;
    kind: 'master' | 'implementation' | 'review' | 'delivery';
    operation?: {
        action: 'create_draft_pr' | 'merge_pr';
        actorId: string;
        candidateRunId: string;
        candidateRevision: string;
        artifactRevision: string;
        commitSha: string;
        candidateFingerprint: string;
        repositoryUrl: string;
        baseRevision: string;
        baseBranch: string;
        remoteBranch: string;
        workTitle: string;
        changeSummary: string;
        qaStatus: string;
        phase: 'queued' | 'published' | 'pr_created' | 'ready_intent' | 'merge_intent' | 'merged';
        effectIntentGeneration?: number;
        external?: { pullRequestNumber?: number; pullRequestUrl?: string; headSha?: string; baseSha?: string; mergeSha?: string; pullRequestNodeId?: string };
        priorDeliveryRunId?: string;
        reviewRunId?: string;
        originalActorId?: string;
        mergeMethod?: 'merge' | 'squash' | 'rebase';
        integrationBaseSha?: string;
        qaPolicySnapshot?: QaPolicy;
        policySnapshot?: { id: string; version: string; requiredChecks: string[] };

    };
    qaPolicySnapshot?: QaPolicy;
    reviewBinding?: { candidateRunId: string; commitSha: string; candidateFingerprint: string; diffArtifactId: string; diffRevision: string; qaArtifactIds: string[] };
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
export function isCausalMasterWake(run: Run): boolean {
    return run.kind === 'master' && run.status === 'failed' && run.generation === 0 && !run.threadId &&
        (Boolean(run.causedByRunId) || run.error?.startsWith('Master wake was not dispatched:') === true);
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
    profile?: {id:string;name:string;data:Record<string,unknown>};
    connectionId?: string;
    connectorId?: string;
    model?: string;
    legacy?: boolean;
    provider: 'openai';
    method: 'codex-host';
    skills: Array<{bundle?:SkillBundle;id:string;name:string;content:string;provenance?:string;sourceUrl?:string;requestedRef?:string;resolvedSha?:string;sourcePath?:string;contentSha256?:string;sourceContentSha256?:string;catalogUrl?:string;catalogResolvedSha?:string;copiedFrom?:{settingId:string;projectId:string;sourceUrl?:string;provenance?:string;requestedRef?:string;resolvedSha?:string;sourcePath?:string;contentSha256?:string;sourceContentSha256?:string;catalogUrl?:string;catalogResolvedSha?:string;catalogName?:string;pluginName?:string;includedReferences?:string[];bundleSha256?:string}}>;
    tools: string[];
}
export interface RuntimeProvider {
    provider: 'openai';
    method: 'codex-host';
    connectorId: string;
    available: boolean;
    projectIds?: string[];
    runKinds?: string[];
    codexAppServer?: boolean;
    localWorktrees?: boolean;
    models: string[];
    lastSeen: string;
    verifiedRunId?: string;
    verifiedAt?: string;
}
