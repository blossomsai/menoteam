import { z } from 'zod';
import type { Setting } from './types.js';

export const LOCAL_QA_CONTRACT = 'project-local-qa/v2';
export const REQUIRED_LOCAL_QA = ['tests', 'typecheck', 'build', 'postgres'] as const;
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/u);
export const qaResource = z.object({id:identifier,kind:z.literal('postgres'),hostname:z.enum(['127.0.0.1','localhost']),port:z.number().int().min(1).max(65535),database:identifier,disposable:z.literal(true)}).strict().refine(r=>r.database!=='menoteam_workbench_runtime', 'Runtime database is forbidden');
const command = z.object({executable:z.enum(['node','repo-bin']),bin:identifier.optional(),args:z.array(z.string().max(2000)).max(100),timeoutMs:z.number().int().min(100).max(600_000)}).strict().refine(c=>c.executable!=='repo-bin'||!!c.bin);
const requirement = z.object({id:identifier,category:z.enum(REQUIRED_LOCAL_QA),commands:z.array(command).min(1).max(10),report:z.enum(['vitest-json','node-test-tap','none'])}).strict().refine(r=>!['tests','postgres'].includes(r.category)||r.report!=='none').refine(r=>r.report!=='node-test-tap'||r.commands.length===1&&r.commands[0]?.executable==='node'&&r.commands[0].args.includes('--test')&&r.commands[0].args.includes('--test-reporter=tap'), 'Node test evidence requires the actual built-in test runner');
// This adapter is an explicit saved policy for Menoteam, never a generic Connector default.
export const MENOTEAM_QA_REQUIREMENTS = [
  {id:'full-suite',category:'tests',commands:[{executable:'repo-bin',bin:'vitest',args:['run','--fileParallelism=false','--reporter=json','--outputFile={reportFile}'],timeoutMs:600_000}],report:'vitest-json'},
  {id:'three-typechecks',category:'typecheck',commands:['tsconfig.json','tsconfig.local-ui.json','tsconfig.workbench-ui.json'].map(config=>({executable:'repo-bin',bin:'tsc',args:['--noEmit','-p',config],timeoutMs:300_000})),report:'none'},
  {id:'isolated-builds',category:'build',commands:[{executable:'repo-bin',bin:'tsc',args:['-p','tsconfig.json','--outDir','{outputDir}/server'],timeoutMs:300_000},...['local','workbench'].map(ui=>({executable:'repo-bin',bin:'vite',args:['build','--config',`vite.${ui}.config.ts`,'--outDir',`{outputDir}/${ui}`],timeoutMs:300_000}))],report:'none'},
  {id:'both-postgres-suites',category:'postgres',commands:[{executable:'repo-bin',bin:'vitest',args:['run','tests/workbench-postgres.test.ts','tests/postgres-repository.test.ts','--fileParallelism=false','--reporter=json','--outputFile={reportFile}'],timeoutMs:600_000}],report:'vitest-json'},
] as const;
export const qaPolicyData = z.object({provider:z.literal('qa'),purpose:z.literal('qa'),url:z.string().url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;}),enabled:z.boolean().default(true),configuredBy:z.string().optional(),coverage:z.enum(['project/v1','menoteam-full/v2']),requirements:z.array(requirement).min(1).max(20),resource:qaResource.optional()}).strict().superRefine((p,ctx)=>{
  if(new Set(p.requirements.map(r=>r.id)).size!==p.requirements.length)ctx.addIssue({code:'custom',message:'QA requirement IDs must be unique'});
  if(p.requirements.some(r=>r.category==='postgres')&&!p.resource)ctx.addIssue({code:'custom',message:'Explicit disposable PostgreSQL resource is required'});
  if(/^https:\/\/github\.com\/blossomsai\/menoteam(?:\.git)?\/?$/iu.test(p.url)&&p.coverage!=='menoteam-full/v2')ctx.addIssue({code:'custom',message:'Menoteam QA coverage cannot be reduced'});
  if(p.coverage==='menoteam-full/v2'&&(JSON.stringify(p.requirements)!==JSON.stringify(MENOTEAM_QA_REQUIREMENTS)||!p.resource))ctx.addIssue({code:'custom',message:'Menoteam requires the full suite, three typechecks, isolated builds and both PostgreSQL suites'});
});
export const qaPolicySnapshot = z.object({id:z.string().min(1),version:timestamp,projectId:z.string().min(1),repositoryUrl:z.string().url(),configuredBy:z.string().min(1),coverage:z.enum(['project/v1','menoteam-full/v2']),requirements:z.array(requirement).min(1).max(20),resource:qaResource.optional()}).strict();
export type QaPolicy = z.infer<typeof qaPolicySnapshot>;
export function savedQaPolicy(settings:Setting[],projectId:string,repositoryUrl:string):QaPolicy|undefined {
  const matches=settings.filter(s=>s.kind==='connection'&&s.projectId===projectId&&s.data.provider==='qa'&&s.data.purpose==='qa'&&s.data.enabled===true&&s.data.url===repositoryUrl);
  if(matches.length!==1)return;
  const s=matches[0]!, parsed=qaPolicyData.safeParse(s.data);
  if(!parsed.success||!parsed.data.configuredBy)return;
  const {coverage,requirements,resource,configuredBy}=parsed.data;
  return qaPolicySnapshot.parse({id:s.id,version:s.updatedAt,projectId,repositoryUrl,configuredBy,coverage,requirements,...(resource?{resource}:{})});
}
export function sameQaPolicy(a:unknown,b:unknown):boolean {
  const left=qaPolicySnapshot.safeParse(a),right=qaPolicySnapshot.safeParse(b);
  return left.success&&right.success&&JSON.stringify(left.data)===JSON.stringify(right.data);
}
export const qaMetrics=z.object({total:z.number().int().nonnegative(),passed:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),skipped:z.number().int().nonnegative()}).strict();
export const fixedQaCheck=z.object({requirementId:z.string(),category:z.enum(REQUIRED_LOCAL_QA),source:z.literal('fixed-connector'),name:z.string(),command:z.string(),exitCode:z.number().int().nullable(),output:z.string(),outputChannel:z.literal('combined'),durationMs:z.number().nonnegative(),startedAt:timestamp,finishedAt:timestamp,testedRevision:z.string().nullable(),metrics:qaMetrics.optional()}).strict();
export type FixedQaCheck=z.infer<typeof fixedQaCheck>;
export const fixedQaSnapshot=z.object({localQaContract:z.literal(LOCAL_QA_CONTRACT),policy:qaPolicySnapshot.optional(),candidateFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),stale:z.boolean(),verification:z.enum(['current','unknown']),capturedAt:timestamp,checks:z.array(fixedQaCheck),revision:z.string().optional()}).strict();
export function hasRequiredLocalQa(value:unknown,fingerprint:string,policy?:QaPolicy):boolean {
  const parsed=fixedQaSnapshot.safeParse(value);
  if(!parsed.success||!policy||!sameQaPolicy(parsed.data.policy,policy))return false;
  const qa=parsed.data,captured=Date.parse(qa.capturedAt);
  return qa.candidateFingerprint===fingerprint&&qa.stale===false&&qa.verification==='current'&&captured<=Date.now()&&captured>=Date.parse(policy.version)&&qa.checks.length===policy.requirements.length&&policy.requirements.every(r=>{
    const matches=qa.checks.filter(c=>c.requirementId===r.id),check=matches[0];
    return matches.length===1&&!!check&&check.category===r.category&&check.command===JSON.stringify(r.commands)&&check.exitCode===0&&check.testedRevision===fingerprint&&Date.parse(check.startedAt)>=Date.parse(policy.version)&&Date.parse(check.startedAt)<=Date.parse(check.finishedAt)&&Date.parse(check.finishedAt)<=captured&&(r.report==='none'||!!check.metrics&&check.metrics.total>0&&check.metrics.total===check.metrics.passed&&check.metrics.failed===0&&check.metrics.skipped===0);
  });
}
