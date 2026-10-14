import { describe, expect, it } from 'vitest';
import { isPreEffectStagingRun, type Run } from '../src/workbench/types.js';

const discovery={kind:'delivery',operation:{action:'deploy_staging',phase:'build_discovery'}} as Run;
describe('staging retirement boundary',()=>{
  it('permits only pre-effect deploy discovery, including frozen builds',()=>{
    expect(isPreEffectStagingRun(discovery)).toBe(true);
    expect(isPreEffectStagingRun({...discovery,operation:{...discovery.operation!,buildStatus:'verified',imageDigest:'sha256:fixture'}})).toBe(true);
  });
  it.each([{effectIntentGeneration:0},{effectIntentGeneration:1},{stagingEffectStage:'intent'},{stagingEffectStage:'transport_intent'},{stagingReceipt:{}},{phase:'deploy_unknown'},{phase:'deploy_intent'},{action:'rollback_staging'}])('never retires mutation or remote evidence %j',delta=>{
    expect(isPreEffectStagingRun({...discovery,operation:{...discovery.operation!,...delta}} as Run)).toBe(false);
  });
});
