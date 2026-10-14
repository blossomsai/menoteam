/** One Vitest wall-clock budget shared by sequential fixtures in the same test. */
export const QA_FIXTURE_CLEANUP_RESERVE_MS=10_000;
// Let cleanup's bounded stop proof settle before its external deadline race fires.
export const QA_FIXTURE_CLEANUP_SETTLE_MS=500;
export const QA_FIXTURE_FINALIZE_RESERVE_MS=500;
export const QA_FIXTURE_CREATE_RESERVE_MS=500;
// Covers the fixture's 5s parent handshake plus one second to finish the next-owner proof.
export const QA_FIXTURE_ACTION_RESERVE_MS=6_000;
export const QA_FIXTURE_VITEST_MARGIN_MS=2_000;
export function qaFixtureBudget(vitestTimeoutMs:number,fixtureCount=1,now:()=>number=Date.now){
  const fixtureReserve=QA_FIXTURE_CLEANUP_RESERVE_MS+QA_FIXTURE_FINALIZE_RESERVE_MS+QA_FIXTURE_CREATE_RESERVE_MS+QA_FIXTURE_ACTION_RESERVE_MS;
  if(!Number.isSafeInteger(vitestTimeoutMs)||!Number.isSafeInteger(fixtureCount)||fixtureCount<1||vitestTimeoutMs<QA_FIXTURE_VITEST_MARGIN_MS+fixtureCount*fixtureReserve)throw new Error('Vitest timeout cannot reserve fixture creation, action, cleanup, finalization and margin');
  const deadline=now()+vitestTimeoutMs-QA_FIXTURE_VITEST_MARGIN_MS;
  let remaining=fixtureCount;
  let drainRequired=false;
  const pendingFinalizations=new Set<Promise<unknown>>();
  const failedFinalizations:unknown[]=[];
  const futureFixtures=()=>Math.max(0,remaining-1);
  const futureReserve=()=>futureFixtures()*fixtureReserve;
  const actionMs=()=>Math.max(0,deadline-now()-QA_FIXTURE_CLEANUP_RESERVE_MS-QA_FIXTURE_FINALIZE_RESERVE_MS-futureReserve());
  const creationMs=()=>Math.max(0,Math.min(QA_FIXTURE_CREATE_RESERVE_MS,actionMs()-QA_FIXTURE_ACTION_RESERVE_MS));
  const cleanupMs=()=>Math.max(0,Math.min(QA_FIXTURE_CLEANUP_RESERVE_MS,deadline-now()-QA_FIXTURE_FINALIZE_RESERVE_MS-futureReserve()));
  const finalizeMs=()=>Math.max(0,Math.min(QA_FIXTURE_FINALIZE_RESERVE_MS,deadline-now()-futureReserve()));
  return {
    remainingFixtures:()=>remaining,
    actionMs,
    creationMs,
    cleanupMs,
    finalizeMs,
    assertActionStart:(creationComplete=false)=>{
      if(remaining<1)throw new Error('QA fixture budget exhausted');
      if(failedFinalizations.length)throw new Error('Previous fixture finalization failed; ownership retained and no action started');
      if(pendingFinalizations.size)throw new Error('Previous fixture directory finalization is still pending; no action started');
      if(drainRequired)throw new Error('Previous fixture lifecycle requires an explicit safe drain; no action started');
      if((!creationComplete&&creationMs()<QA_FIXTURE_CREATE_RESERVE_MS)||actionMs()<(creationComplete?QA_FIXTURE_ACTION_RESERVE_MS:QA_FIXTURE_CREATE_RESERVE_MS+QA_FIXTURE_ACTION_RESERVE_MS)||cleanupMs()<QA_FIXTURE_CLEANUP_RESERVE_MS||finalizeMs()<QA_FIXTURE_FINALIZE_RESERVE_MS)throw new Error('QA fixture deadline exhausted; no action started');
    },
    trackFinalization:<T>(promise:Promise<T>,failClosedOnReject=true):Promise<T>=>{
      let tracked:Promise<T>;
      tracked=promise.then(value=>{pendingFinalizations.delete(tracked);return value;},error=>{pendingFinalizations.delete(tracked);if(failClosedOnReject)failedFinalizations.push(error);throw error;});
      pendingFinalizations.add(tracked);
      // A timed-out caller may never await the original operation again.
      void tracked.catch(()=>{});
      return tracked;
    },
    requireDrain:()=>{drainRequired=true;},
    drainFinalizations:async()=>{while(pendingFinalizations.size)await Promise.all([...pendingFinalizations]);if(failedFinalizations.length)throw new AggregateError(failedFinalizations,'QA fixture finalization failed; ownership retained');drainRequired=false;},
    pendingFinalizations:()=>pendingFinalizations.size,
    failedFinalizations:()=>failedFinalizations.length,
    finishFixture:()=>{if(remaining<1)throw new Error('QA fixture budget exhausted');if(failedFinalizations.length)throw new Error('QA fixture finalization failed; ownership retained');if(now()>deadline)throw new Error('QA fixture deadline expired before finalization completed');if(pendingFinalizations.size)throw new Error('QA fixture finalization is still pending');remaining--;},
    get deadline(){return deadline;},
  };
}
export type QaFixtureBudget=ReturnType<typeof qaFixtureBudget>;
