import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { guardProxySockets } from '../src/proxy-sockets.js';

test('client ECONNRESET is contained and closes only the socket pair', () => {
  const client = new PassThrough();
  const upstream = new PassThrough();
  const logs = [];
  guardProxySockets(
    { headers: { host: 'dev-18923.agentsweb.space' }, url: '/socket' },
    client,
    upstream,
    { route: 'encoded-port', target: '18923' },
    (line) => logs.push(line)
  );

  const error = new Error('read ECONNRESET');
  error.code = 'ECONNRESET';
  assert.doesNotThrow(() => client.emit('error', error));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"side":"client"/);
  assert.match(logs[0], /"code":"ECONNRESET"/);
  assert.equal(upstream.destroyed, true);
});

test('upstream errors return a bounded gateway failure', () => {
  const client = new PassThrough();
  const upstream = new PassThrough();
  const logs = [];
  guardProxySockets(
    { headers: { host: 'codex.agentsweb.space' }, url: '/' },
    client,
    upstream,
    { route: 'agent', target: 'codex' },
    (line) => logs.push(line)
  );

  const error = new Error('connect refused');
  error.code = 'ECONNREFUSED';
  assert.doesNotThrow(() => upstream.emit('error', error));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"side":"upstream"/);
  assert.equal(upstream.destroyed, true);
});
