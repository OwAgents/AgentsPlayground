import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRuntime } from '../src/agents.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForState(runtime, expected, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = runtime.snapshot(false);
    if (snapshot.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expected}: ${JSON.stringify(runtime.snapshot(false))}`);
}

test('a restarted console adopts and controls the same detached agent process group', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-agents-lifetime-'));
  const previousStateDir = process.env.WORKER_AGENTS_STATE_DIR;
  const previousLog = process.env.AGENT_CONSOLE_AGENT_LOG;
  process.env.WORKER_AGENTS_STATE_DIR = path.join(temporary, 'state');
  process.env.AGENT_CONSOLE_AGENT_LOG = path.join(temporary, '{agentId}.log');
  const port = await freePort();
  const script = `require('node:http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')`;
  const definition = {
    id: 'lifetime-test',
    name: 'Lifetime Test',
    basePort: port,
    path: '/',
    command: () => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
    env: () => ({ ...process.env })
  };
  const original = new AgentRuntime(definition, () => {});
  const restarted = new AgentRuntime(definition, () => {});

  try {
    await original.start();
    const running = await waitForState(original, 'running');
    const originalPid = running.pid;
    assert.ok(originalPid > 0);

    const adopted = await restarted.reconcile();
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.pid, originalPid);
    assert.equal(restarted.snapshot(false).state, 'running');

    await restarted.stop();
    assert.equal(restarted.snapshot(false).state, 'stopped');
    assert.equal(fs.existsSync(path.join(temporary, 'state', 'lifetime-test.json')), false);
  } finally {
    if (restarted.snapshot(false).state !== 'stopped') await restarted.stop().catch(() => {});
    if (previousStateDir === undefined) delete process.env.WORKER_AGENTS_STATE_DIR;
    else process.env.WORKER_AGENTS_STATE_DIR = previousStateDir;
    if (previousLog === undefined) delete process.env.AGENT_CONSOLE_AGENT_LOG;
    else process.env.AGENT_CONSOLE_AGENT_LOG = previousLog;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
