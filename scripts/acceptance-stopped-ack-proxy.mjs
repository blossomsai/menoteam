// Acceptance-only loopback fault injector. No DB/spool mutation, host override or credential logging.
// First discover a new fixture Connector against its empty project, configure Work, then stop only that idle Connector.
// Queue the member run; start this proxy with its exact run/generation, point only the fixture Connector here and restart it.
// After revocation/drop evidence, stop the owned fixture Connector, recover the window and restart with unchanged ID/data.
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createStoppedAckProxy({ port = 0, upstreamPort, runId, generation, windowMs = 30_000, timeoutMs = 5_000 }) {
  const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!integer(port, 0, 65535) || !integer(upstreamPort, 1, 65535) || port !== 0 && port === upstreamPort || !/^[A-Za-z0-9_-]{1,100}$/.test(runId ?? '') ||
      !integer(generation, 1, 2147483647) || !integer(windowMs, 100, 60_000) || !integer(timeoutMs, 100, 30_000)) throw Error('Invalid bounded proxy configuration');
  const target = `/api/workbench/connector/runs/${runId}/stopped`;
  const state = { runId, generation, dropped: false, droppedAt: null, windowUntil: 0, injected503: 0, upstream2xxStatus: null };
  const sockets = new Set(), requests = new Set();
  let closing = false, closeTask, dropOwner;
  const status = () => ({ ...state, windowActive: Date.now() < state.windowUntil, pendingRequests: requests.size });
  const server = http.createServer((req, res) => {
    if (closing) { res.writeHead(503).end(); req.resume(); return; }
    // Only origin-form paths are allowed; request Host never selects the upstream.
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || req.url.length > 8192) {
      res.writeHead(400).end(); req.resume(); return;
    }
    if (req.method === 'GET' && req.url === '/__control/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status())); req.resume(); return; }
    if (req.method === 'POST' && req.url === '/__control/recover') { state.windowUntil = 0; res.writeHead(204).end(); req.resume(); return; }
    const context = { upstream: null, response: null, timer: null, done: false };
    requests.add(context);
    const finish = () => { if (context.done) return; context.done = true; clearTimeout(context.timer); requests.delete(context); if (dropOwner === context) dropOwner = undefined; context.upstream?.destroy(); context.response?.destroy(); };
    const fail = code => { if (context.done) return; if (!res.headersSent) res.writeHead(code).end(); else res.destroy(); finish(); };
    context.timer = setTimeout(() => { fail(504); if (!req.complete) req.destroy(); }, timeoutMs);
    res.once('close', finish);
    req.once('aborted', () => { finish(); res.destroy(); });
    req.once('error', () => { finish(); res.destroy(); });
    const body = []; let size = 0;
    req.on('data', chunk => { if (context.done) return; size += chunk.length; if (size > 1_048_576) { fail(413); req.destroy(); } else body.push(chunk); });
    req.once('end', () => {
      if (context.done) return;
      const payload = Buffer.concat(body);
      let match = false;
      if (req.method === 'POST' && req.url === target) {
        try { match = JSON.parse(payload.toString('utf8')).generation === generation; } catch { /* Let the real service reject invalid JSON. */ }
      }
      if (match && Date.now() < state.windowUntil) { state.injected503++; res.writeHead(503).end(); finish(); return; }
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, connection: 'close' } }, response => {
        if (context.done) { response.destroy(); return; }
        context.response = response;
        response.once('error', () => fail(502));
        response.once('aborted', () => fail(502));
        if (match && !state.dropped && !dropOwner && response.statusCode >= 200 && response.statusCode < 300) {
          // Drain the actual successful response before dropping its downstream ACK.
          dropOwner = context;
          response.once('end', () => {
            if (context.done) return;
            state.dropped = true; state.droppedAt = new Date().toISOString(); state.windowUntil = Date.now() + windowMs;
            state.upstream2xxStatus = response.statusCode;
            finish(); res.destroy();
          });
          response.resume();
        } else {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.once('end', finish); response.pipe(res);
        }
      });
      context.upstream = upstream;
      upstream.once('error', () => fail(502));
      upstream.end(payload);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  return { port: server.address().port, status, close: () => closeTask ??= (async () => {
    closing = true;
    const stopped = new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    for (const context of requests) { context.done = true; clearTimeout(context.timer); context.upstream?.destroy(); context.response?.destroy(); }
    requests.clear(); for (const socket of sockets) socket.destroy();
    await stopped;
  })() };
}

// node scripts/acceptance-stopped-ack-proxy.mjs --port 3210 --upstream-port 3200 --run-id run_UUID --generation 1
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = { '--port': 'port', '--upstream-port': 'upstreamPort', '--run-id': 'runId', '--generation': 'generation', '--window-ms': 'windowMs', '--timeout-ms': 'timeoutMs' };
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = flags[process.argv[i]], value = process.argv[i + 1];
      if (!key || value === undefined || Object.hasOwn(options, key) || key !== 'runId' && !/^\d+$/.test(value)) throw Error('Invalid proxy arguments');
      options[key] = key === 'runId' ? value : Number(value);
    }
    if (!options.port || !options.upstreamPort) throw Error('Explicit ports required');
    const proxy = await createStoppedAckProxy(options);
    console.log(JSON.stringify({ event: 'ready', port: proxy.port, runId: options.runId, generation: options.generation }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void proxy.close().then(() => process.exit(0), () => process.exit(1)); });
  } catch { console.error('Bounded acceptance proxy setup failed'); process.exitCode = 1; }
}
