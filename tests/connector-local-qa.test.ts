import {describe,it,expect} from 'vitest';
import { mkdtemp,writeFile,rm,readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { qaFixtureBudget } from './helpers/qa-fixture-budget.js';
import { qaProcessFixture,type QaProcessFixture } from './helpers/qa-process-fixture.js';
import { captureRequiredLocalQa } from '../src/connector/local-qa.js';
import { hasRequiredLocalQa,type QaPolicy } from '../src/workbench/local-qa.js';
import { ConnectorRunner } from '../src/connector/runner.js';
import { stateKey, writeSecureJson } from '../src/connector/state.js';
import type { WorkbenchConnectorClient } from '../src/connector/client.js';
import type { CodexAppServer } from '../src/connector/codex.js';

async function fixture(action:(cwd:string,f:QaProcessFixture)=>Promise<void>,vitestTimeoutMs:number){await qaProcessFixture(async f=>{const cwd=f.directory;await promisify(execFile)('git',['init'],{cwd});await writeFile(path.join(cwd,'.gitignore'),'parent-state/\n');await action(cwd,f);},qaFixtureBudget(vitestTimeoutMs));}
function execution(f:QaProcessFixture){const state=f.state();state.directory=path.join(f.directory,'parent-state',state.nonce);return state;}
function policy():QaPolicy{return {id:'generic-policy',version:'2000-01-01T00:00:00.000Z',projectId:'generic-project',repositoryUrl:'https://github.com/example/non-menoteam',configuredBy:'owner',coverage:'project/v1',requirements:[{id:'real-tests',category:'tests',commands:[{executable:'node',args:['--test','--test-reporter=tap','verify.cjs'],timeoutMs:10_000}],report:'node-test-tap'},{id:'syntax',category:'typecheck',commands:[{executable:'node',args:['--check','verify.cjs'],timeoutMs:10_000}],report:'none'},{id:'build',category:'build',commands:[{executable:'node',args:['-e',"require('node:fs').writeFileSync(process.argv[1], 'built fixture')",'{outputDir}/built.txt'],timeoutMs:10_000}],report:'none'}]};}
describe('generic authorized fixed-parent QA (real subprocesses, no network)',()=>{
  it('does not release legacy or unknown crashed QA from a native stop flag',async()=>{
    const dataDir=await mkdtemp(path.join(os.tmpdir(),'menoteam-qa-recovery-'));let stopped=0,runner:ConnectorRunner;
    const file=path.join(dataDir,'spool',`${stateKey('qa-run','1')}.json`),spool={runId:'qa-run',generation:1,events:[],artifacts:[],qaInFlight:true};
    const client={readRun:async()=>({id:'qa-run',generation:1,status:'interrupted'}),stopped:async()=>{stopped++;},claim:async()=>{await runner.stop();return undefined;}} as unknown as WorkbenchConnectorClient;
    runner=new ConnectorRunner({serverUrl:'http://fixture.invalid',token:'fixture-only',connectorId:'fixture',dataDir,projects:{},pollIntervalMs:1},{client:()=>client,native:()=>({start:async()=>['gpt-6.1-sol'],stop:async()=>{}} as unknown as CodexAppServer)});
    try{await writeSecureJson(file,spool);await runner.run();expect(stopped).toBe(0);expect(JSON.parse(await readFile(file,'utf8'))).toEqual(spool);}finally{await rm(dataDir,{recursive:true,force:true});}
  });
  it('captures a valid non-Menoteam repository and proves real child credential isolation',async()=>fixture(async (cwd,f)=>{
    const keys=['MENOTEAM_GITHUB_TOKEN','WORKBENCH_GITHUB_TOKEN','GITHUB_TOKEN','GH_TOKEN','MENOTEAM_CONNECTOR_CONFIG','WORK_MAP_TEST_DATABASE_URL'];const old=keys.map(key=>process.env[key]);
    keys.forEach(key=>process.env[key]='private-parent-fixture');
    try {
      await writeFile(path.join(cwd,'verify.cjs'),`const assert=require('node:assert/strict'); for(const key of ${JSON.stringify(keys)})assert.equal(process.env[key],undefined);`);
      const saved=policy();const states:string[]=[];
      const qa=await f.track(captureRequiredLocalQa(cwd,{policy:saved,resources:{},dataDirectory:path.join(cwd,'parent-state'),state:execution(f),signal:f.abort.signal,save:async state=>{states.push(state.phase);await writeSecureJson(path.join(cwd,'parent-state','spool.json'),state);}}));
      // Parent state must live outside candidate bytes in production; fixture state is git-ignored.
      expect(hasRequiredLocalQa(qa,qa.candidateFingerprint,saved)).toBe(true);expect(qa.checks).toHaveLength(3);
      expect(states).toContain('starting');expect(states).toContain('running');expect(states.at(-1)).toBe('stopped');
      expect(keys.every(key=>process.env[key]==='private-parent-fixture')).toBe(true);
      expect(JSON.stringify(saved)).not.toMatch(/Menoteam|tsconfig|vite|postgres/);
    }finally{keys.forEach((key,index)=>{if(old[index]===undefined)delete process.env[key];else process.env[key]=old[index];});}
  },45_000),45_000);
  it('passes only explicitly authorized disposable DB config to the real child while retaining parent ambient values',async()=>fixture(async (cwd,f)=>{
    const old=process.env.WORK_MAP_TEST_DATABASE_URL;process.env.WORK_MAP_TEST_DATABASE_URL='unconfigured-parent-value';
    const saved=policy(),database=`generic_${Date.now()}_test`,url=`postgres://fixture-only@127.0.0.1:65432/${database}`;
    saved.resource={id:'explicit-child-db',kind:'postgres',hostname:'127.0.0.1',port:65432,database,disposable:true};
    try{await writeFile(path.join(cwd,'verify.cjs'),`require('node:assert/strict').equal(process.env.WORK_MAP_TEST_DATABASE_URL,${JSON.stringify(url)});`);
      const qa=await f.track(captureRequiredLocalQa(cwd,{policy:saved,resources:{[saved.resource.id]:{url}},dataDirectory:path.join(cwd,'parent-state'),state:execution(f),signal:f.abort.signal,save:async state=>{await writeSecureJson(path.join(cwd,'parent-state','spool.json'),state);}}));
      expect(hasRequiredLocalQa(qa,qa.candidateFingerprint,saved)).toBe(true);expect(process.env.WORK_MAP_TEST_DATABASE_URL).toBe('unconfigured-parent-value');
    }finally{if(old===undefined)delete process.env.WORK_MAP_TEST_DATABASE_URL;else process.env.WORK_MAP_TEST_DATABASE_URL=old;}
  },45_000),45_000);
  it('does not execute commands for missing policy or unbound resource',async()=>fixture(async (cwd,f)=>{
    const options={resources:{},dataDirectory:path.join(cwd,'parent-state'),save:async()=>{throw Error('No process should be started');}};
    expect((await captureRequiredLocalQa(cwd,options)).verification).toBe('unknown');
    const saved=policy();saved.resource={id:'not-authorized',kind:'postgres',hostname:'127.0.0.1',port:55439,database:'fixture_test',disposable:true};
    expect((await captureRequiredLocalQa(cwd,{...options,policy:saved})).checks).toEqual([]);
  },20_000),20_000);
});
