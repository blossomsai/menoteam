import type { Sql } from "postgres";
export class WorkbenchStore {
    constructor(public sql: Sql) {
    }
    async put(kind: string, data: {
        id: string;
        projectId?: string;
    }, tx = this.sql): Promise<void> {
        const rows = await tx `INSERT INTO wb_records(id,kind,project_id,data) VALUES (${data.id},${kind},${data.projectId ?? null},${tx.json(data as never)}) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now() WHERE wb_records.kind=EXCLUDED.kind AND wb_records.project_id IS NOT DISTINCT FROM EXCLUDED.project_id RETURNING id`;
        if (!rows[0])
            throw Object.assign(new Error("Record scope cannot change"), {
                statusCode: 409
            });
        ;
    }
    async get<T>(kind: string, id: string, tx = this.sql): Promise<T | undefined> {
        const rows = await tx `SELECT data FROM wb_records WHERE id=${id} AND kind=${kind}`;
        return rows[0]?.data as T | undefined;
    }
    async list<T>(kind: string, projectId?: string, tx = this.sql): Promise<T[]> {
        const rows = projectId === undefined ? await tx `SELECT data FROM wb_records WHERE kind=${kind} ORDER BY updated_at,id` : await tx `SELECT data FROM wb_records WHERE kind=${kind} AND project_id=${projectId} ORDER BY updated_at,id`;
        return rows.map(r => r.data as T);
    }
    async transaction<T>(scope: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
        return await this.sql.begin(async (tx) => {
            await tx `SELECT pg_advisory_xact_lock(hashtext('menoteam-workbench-state'))`;
            return fn(tx as unknown as Sql);
        }) as T;
    }
    async scopedList<T>(kind: string, projectIds: string[], limit = 500, tx = this.sql): Promise<T[]> {
        const rows = await tx `SELECT data FROM (SELECT data,updated_at,id FROM wb_records WHERE kind=${kind} AND project_id=ANY(${projectIds}) ORDER BY updated_at DESC,id DESC LIMIT ${limit}) recent ORDER BY updated_at,id`;
        return rows.map(r => r.data as T);
    }
    async artifactMetadata(projectIds:string[],tx=this.sql,workId?:string):Promise<import('./types.js').Artifact[]>{
        const rows=await tx`SELECT CASE WHEN data->>'kind'='diff' THEN jsonb_set(data,'{data}',(data->'data')-'patch') ELSE data-'data' END AS data FROM wb_records WHERE kind='artifact' AND project_id=ANY(${projectIds}) AND data->>'kind'<>'diff_file_chunk' AND (${workId??null}::text IS NULL OR data->>'workId'=${workId??null}) ORDER BY updated_at DESC,id DESC LIMIT 200`;
        return rows.map(r=>r.data as import('./types.js').Artifact);
    }
    async runArtifacts(projectId:string,runId:string,tx=this.sql):Promise<import('./types.js').Artifact[]>{
        const rows=await tx`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${projectId} AND data->>'runId'=${runId} AND data->>'kind'<>'diff_file_chunk' ORDER BY updated_at,id LIMIT 100`;
        return rows.map(r=>r.data as import('./types.js').Artifact);
    }
    async latestWorkDiff(projectId:string,workId:string,tx=this.sql):Promise<import('./types.js').Artifact|undefined>{
        const rows=await tx`SELECT jsonb_set(data,'{data}',jsonb_build_object('candidateRevision',data->'data'->'candidateRevision')) AS data FROM wb_records WHERE kind='artifact' AND project_id=${projectId} AND data->>'workId'=${workId} AND data->>'kind'='diff' ORDER BY updated_at DESC,id DESC LIMIT 1`;
        return rows[0]?.data as import('./types.js').Artifact|undefined;
    }
    async assignedQaArtifacts(projectId:string,workId:string,runId:string,artifactIds:string[],tx=this.sql):Promise<import('./types.js').Artifact[]>{
        const rows=await tx`SELECT data FROM wb_records WHERE kind='artifact' AND project_id=${projectId} AND data->>'workId'=${workId} AND data->>'runId'=${runId} AND data->>'kind'='qa' AND id=ANY(${artifactIds}) LIMIT 100`;
        return rows.map(r=>r.data as import('./types.js').Artifact);
    }
    async messages(projectId: string, workId: string | undefined, before?: string, after?: string, tx = this.sql): Promise<{messages: import('./types.js').Message[]; nextBefore:string|null}> {
        let time:string|null=null;let cursorId:string|null=null;
        if(before){try{const parsed=JSON.parse(Buffer.from(before,'base64url').toString());if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||typeof parsed[1]!=='string')throw new Error();[time,cursorId]=parsed;}catch{throw Object.assign(new Error('Invalid history cursor'),{statusCode:400});}}
        const rows=await tx`SELECT data FROM wb_records WHERE kind='message' AND project_id=${projectId} AND data->>'workId' IS NOT DISTINCT FROM ${workId??null} AND (${time}::text IS NULL OR (data->>'createdAt',id)<(${time},${cursorId})) AND (${after??null}::text IS NULL OR data->>'createdAt'>=${after??null}) ORDER BY data->>'createdAt' DESC,id DESC LIMIT 101`;
        const page=rows.slice(0,100).map(r=>r.data as import('./types.js').Message).reverse();
        const first=page[0];return {messages:page,nextBefore:rows.length>100&&first?Buffer.from(JSON.stringify([first.createdAt,first.id])).toString('base64url'):null};
    }
}
