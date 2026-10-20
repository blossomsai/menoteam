import { useLayoutEffect, useState } from 'react';
import type { Artifact } from '../types';
import { workbenchApi } from './api';

export function artifactKey(artifact: Artifact) {
  const data = artifact.data as { candidateRevision?: unknown } | undefined;
  return JSON.stringify([artifact.projectId, artifact.workId, artifact.runId, artifact.id, artifact.kind, artifact.revision, artifact.createdAt, artifact.kind === 'diff' ? data?.candidateRevision : undefined]);
}

export function createArtifactReader() {
  const bodies = new Map<string, Artifact>();
  const pending = new Map<string, Promise<Artifact>>();
  let controller = new AbortController();
  const aborted = () => new DOMException('Artifact scope ended', 'AbortError');
  return {
    start() { if (controller.signal.aborted) controller = new AbortController(); },
    dispose() { controller.abort(); bodies.clear(); pending.clear(); },
    forget(reference: Artifact) { bodies.delete(artifactKey(reference)); },
    read(reference: Artifact, consumerSignal?: AbortSignal, force = false): Promise<Artifact> {
      const lifetime = controller;
      if (lifetime.signal.aborted || consumerSignal?.aborted) return Promise.reject(aborted());
      const key = artifactKey(reference);
      if (force) bodies.delete(key);
      let result = bodies.has(key) ? Promise.resolve(bodies.get(key)!) : pending.get(key);
      if (!result) {
        const request = workbenchApi.artifact(reference.id, lifetime.signal).then(body => {
          if (lifetime.signal.aborted || lifetime !== controller) throw aborted();
          const candidateRevision = reference.kind === 'diff' ? (reference.data as { candidateRevision?: unknown } | undefined)?.candidateRevision : undefined;
          if (!body || body.id !== reference.id || body.projectId !== reference.projectId || body.workId !== reference.workId || body.runId !== reference.runId || body.kind !== reference.kind || body.revision !== reference.revision || body.createdAt !== reference.createdAt || !body.data || typeof body.data !== 'object' || Array.isArray(body.data) || Object.keys(body.data).length === 0
            || candidateRevision !== undefined && (body.data as { candidateRevision?: unknown }).candidateRevision !== candidateRevision) throw new Error('Artifact body does not match its metadata');
          bodies.set(key, body);
          return body;
        }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
        pending.set(key, request);
        result = request;
      }
      // A tab/consumer may stop waiting without aborting another consumer's fetch.
      return result.then(body => {
        if (consumerSignal?.aborted || lifetime.signal.aborted || lifetime !== controller) throw aborted();
        return body;
      });
    },
  };
}
export type ArtifactReader = ReturnType<typeof createArtifactReader>;

export function useArtifactReader() {
  const [reader] = useState(createArtifactReader);
  // Layout setup precedes child passive reads, including StrictMode effect replay.
  useLayoutEffect(() => { reader.start(); return () => reader.dispose(); }, [reader]);
  return reader;
}
