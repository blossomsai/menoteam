import type { WorkbenchConnectorClient } from '../../src/connector/client.js';
import { isPreEffectStagingRun } from '../../src/workbench/types.js';

/** Existing lifecycle fixtures model server state via readRun; expose the new control projection too. */
export function withRecoveryState(client:WorkbenchConnectorClient):WorkbenchConnectorClient {
  client.recoveryState=async(id,generation)=>{
    const run=await client.readRun(id);
    return {id:run.id,generation:run.generation,status:run.status,stoppedAt:run.stoppedAt,
      preEffectStaging:isPreEffectStagingRun(run),stagingRetired:Boolean(run.operation?.stagingRetired),
      merged:run.kind==='delivery'&&run.operation?.action==='merge_pr'&&run.operation.phase==='merged',
      qaResourcePolicy:run.qaPolicySnapshot?{resource:run.qaPolicySnapshot.resource,providerResource:run.qaPolicySnapshot.providerResource}:undefined};
  };
  return client;
}
