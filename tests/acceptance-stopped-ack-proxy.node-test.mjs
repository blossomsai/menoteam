import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createStoppedAckProxy } from '../scripts/acceptance-stopped-ack-proxy.mjs';

const target = '/api/workbench/connector/runs/run-target/stopped';
async function stub(handler) {
  const sockets = new Set(); const server = http.createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, sockets, close: async () => {
    const done = new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    for (const socket of sockets) socket.destroy(); await done;
  } };
}
const send = (port, path = target, generation = 1, method = 'POST') => fetch(`http://127.0.0.1:${port}${path}`, {
  method, ...(method === 'GET' ? {} : { body: JSON.stringify({ generation }), headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-private' } }),
  signal: AbortSignal.timeout(2000)
});
function raw(port, requestPath, host) {
  return new Promise((yes, no) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, headers: { host, authorization: 'Bearer fixture-private' } }, response => {
      response.resume(); response.once('end', () => yes(response.statusCode));
    }); request.once('error', no); request.end();
  });
}

test('drops only target-generation successful ACK once; other traffic and explicit recovery pass', { timeout: 5000 }, async () => {
  let count = 0; const bodies = [];
  const responseBytes = Buffer.from(JSON.stringify({ ok: true, note: 'read_run-style response', contents: 'x'.repeat(16_000) }));
  const upstream = await stub((req, res) => { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.once('end', () => {
    count++; bodies.push(Buffer.concat(chunks)); res.writeHead(200, { 'content-type': 'application/json', 'content-length': responseBytes.length }).end(responseBytes);
  }); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1 });
  try {
    await assert.rejects(send(proxy.port)); assert.equal(count, 1);
    assert.equal(proxy.status().dropped, true); assert.equal(proxy.status().upstream2xxStatus, 200);
    assert.equal((await send(proxy.port)).status, 503); assert.equal(count, 1);
    for (const [path, gen, method] of [[target, 2, 'POST'], ['/api/workbench/connector/runs/run-target/renew', 1, 'POST'], [target, 1, 'GET'], ['/api/workbench/connector/runs/other/stopped', 1, 'POST']]) {
      const response = await send(proxy.port, path, gen, method);
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/json');
      const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual(bytes, responseBytes);
      assert.equal(JSON.parse(bytes).note, 'read_run-style response');
      assert.deepEqual(bodies.at(-1), method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify({ generation: gen })));
    }
    assert.equal(count, 5); assert.equal((await send(proxy.port, '/__control/recover')).status, 204);
    assert.equal((await send(proxy.port)).status, 200); assert.equal(count, 6);
    const status = await (await send(proxy.port, '/__control/status', 1, 'GET')).json();
    assert.equal(status.windowActive, false); assert.equal(status.injected503, 1);
    assert.ok(!JSON.stringify(status).includes('fixture-private'));
  } finally { await proxy.close(); await upstream.close(); }
});

test('window expires without another dropped ACK', { timeout: 5000 }, async () => {
  let count = 0;
  const upstream = await stub((req, res) => { req.resume(); req.once('end', () => { count++; res.end('committed'); }); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1, windowMs: 150 });
  try {
    await assert.rejects(send(proxy.port)); assert.equal((await send(proxy.port)).status, 503);
    await delay(Math.max(0, proxy.status().windowUntil - Date.now()) + 20);
    assert.equal((await send(proxy.port)).status, 200); assert.equal(count, 2);
  } finally { await proxy.close(); await upstream.close(); }
});

test('non-2xx target response does not arm the fault', { timeout: 5000 }, async () => {
  let accepted = false;
  const upstream = await stub((req, res) => { req.resume(); req.once('end', () => res.writeHead(accepted ? 200 : 403).end()); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1 });
  try {
    assert.equal((await send(proxy.port)).status, 403); assert.equal(proxy.status().dropped, false);
    accepted = true; await assert.rejects(send(proxy.port)); assert.equal(proxy.status().dropped, true);
  } finally { await proxy.close(); await upstream.close(); }
});

test('absolute/authority targets are rejected and Host cannot change the fixed upstream', { timeout: 5000 }, async () => {
  let intended = 0, foreign = 0;
  const upstream = await stub((req, res) => { intended++; assert.equal(req.headers.host, `127.0.0.1:${upstream.port}`); res.end(); });
  const other = await stub((_req, res) => { foreign++; res.end(); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1 });
  try {
    assert.equal(await raw(proxy.port, `http://127.0.0.1:${other.port}/secret`, 'evil.invalid'), 400);
    assert.equal(await raw(proxy.port, `//127.0.0.1:${other.port}/secret`, 'evil.invalid'), 400);
    assert.equal(await raw(proxy.port, '/healthz', `127.0.0.1:${other.port}`), 200);
    assert.equal(intended, 1); assert.equal(foreign, 0);
    await assert.rejects(createStoppedAckProxy({ upstreamPort: 'https://evil.invalid', runId: 'run-target', generation: 1 }));
    await assert.rejects(createStoppedAckProxy({ port: 65531, upstreamPort: 65531, runId: 'run-target', generation: 1 }));
  } finally { await proxy.close(); await upstream.close(); await other.close(); }
});

test('timeouts abort owned upstream connections without reporting an ACK drop', { timeout: 5000 }, async () => {
  let disconnected; const gone = new Promise(resolve => { disconnected = resolve; });
  const upstream = await stub((req, _res) => { req.resume(); req.socket.once('close', disconnected); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1, timeoutMs: 100 });
  try {
    assert.equal((await send(proxy.port)).status, 504); await gone;
    assert.equal(proxy.status().pendingRequests, 0); assert.equal(proxy.status().dropped, false);
  } finally { await proxy.close(); await upstream.close(); }
});

test('close aborts hanging owned upstreams and settles without waiting for the upstream', { timeout: 5000 }, async () => {
  let entered, disconnected; const ready = new Promise(resolve => { entered = resolve; }); const gone = new Promise(resolve => { disconnected = resolve; });
  const upstream = await stub((req, _res) => { req.resume(); req.socket.once('close', disconnected); entered(); });
  const proxy = await createStoppedAckProxy({ upstreamPort: upstream.port, runId: 'run-target', generation: 1, timeoutMs: 5000 });
  try {
    const pending = send(proxy.port).then(() => assert.fail('Hanging request unexpectedly succeeded'), () => undefined);
    await ready; const started = Date.now(); await proxy.close(); await gone; await pending;
    assert.ok(Date.now() - started < 1000); assert.equal(proxy.status().pendingRequests, 0);
    await proxy.close();
  } finally { await proxy.close(); await upstream.close(); }
});
