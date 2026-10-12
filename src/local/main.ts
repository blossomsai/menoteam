import { createLocalApp } from './app.js';

const port = Number(process.env.PORT ?? 4311);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
const app = await createLocalApp({ dataDir: process.env.LOCAL_DATA_DIR, codexBinary: process.env.CODEX_BINARY });
try { await app.listen({ port, host: '127.0.0.1' }); }
catch (error) { await app.close(); throw error; }
console.log(`Menoteam local workspace: http://127.0.0.1:${port}/`);

let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await app.close(); };
process.once('SIGINT', () => { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); });
process.once('SIGTERM', () => { void shutdown().catch((error) => { console.error(error); process.exitCode = 1; }); });
