import type { Run } from '../workbench/types.js';

/** Local identity is enrollment configuration, never a value supplied by a run. */
export function assertExecutionSelection(run: Run, connectorId: string): void {
  const selected = run.execution?.connectorId ?? run.targetConnectorId ?? run.connectorId;
  if (!selected || selected !== connectorId || run.connectorId !== connectorId)
    throw new Error('Selected Connector execution identity mismatch');
  if (run.targetConnectorId && run.targetConnectorId !== selected)
    throw new Error('Native continuation Connector identity mismatch');
  if (run.execution?.model && run.execution.model !== run.model)
    throw new Error('Frozen execution model mismatch');
  if (run.execution && (run.execution.provider !== 'openai' || run.execution.method !== 'codex-host'))
    throw new Error('Unsupported execution method');
  if (run.execution?.profile && run.execution.profile.id !== run.execution.profileId)
    throw new Error('Frozen execution profile mismatch');
}
