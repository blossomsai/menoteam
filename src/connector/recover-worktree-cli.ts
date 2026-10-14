import { readFile } from 'node:fs/promises';
import { loadConnectorConfig } from './state.js';
import { recoverWorktree, worktreeRecoveryReceipt } from './recover-worktree.js';

// Explicit offline operator command; no network, server mutation, native execution or implicit HEAD.
const [configFile,receiptFile,...extra]=process.argv.slice(2);
if(!configFile||!receiptFile||extra.length)throw new Error('Usage: recover-worktree <owner-only-config> <operator-receipt>');
try{
  const config=await loadConnectorConfig(configFile);
  const receipt=worktreeRecoveryReceipt.parse(JSON.parse(await readFile(receiptFile,'utf8')));
  await recoverWorktree(config,receipt);
  console.log('Work checkout recovered and evidence verified');
}catch{
  // No config values, raw Git stderr, paths or process commands in shared console output.
  console.error('Work checkout recovery failed; preserve state and inspect privately before retry');
  process.exitCode=1;
}
