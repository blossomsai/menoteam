import { loadConnectorConfig } from './state.js';
import { ConnectorRunner } from './runner.js';
const file = process.env.MENOTEAM_CONNECTOR_CONFIG;
if (!file) throw new Error('MENOTEAM_CONNECTOR_CONFIG must point to an owner-only connector configuration');
const runner = new ConnectorRunner(await loadConnectorConfig(file));
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void runner.stop();});
await runner.run();
