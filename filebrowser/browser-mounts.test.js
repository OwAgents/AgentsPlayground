const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { BrowserMountManager, safeMountName } = require('./browser-mounts');

class FakeFuse {
  static EPERM = -1;
  static ENOENT = -2;
  static EIO = -5;
  static EACCES = -13;
  static ENOTDIR = -20;
  static EISDIR = -21;
  static EROFS = -30;

  constructor(mountPath, operations) {
    this.mountPath = mountPath;
    this.operations = operations;
    this.mounted = false;
  }

  mount(callback) {
    this.mounted = true;
    setImmediate(callback);
  }

  unmount(callback) {
    this.mounted = false;
    setImmediate(callback);
  }
}

class FakeSocket extends EventEmitter {
  constructor(responder) {
    super();
    this.readyState = 1;
    this.responder = responder;
    this.sent = [];
  }

  send(raw, callback) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    callback?.();
    if (message.type !== 'request') return;
    setImmediate(async () => {
      try {
        const result = await this.responder(message);
        this.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: message.id, ok: true, result })));
      } catch (error) {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'response',
          id: message.id,
          ok: false,
          error: { code: error.code || 'EIO', message: error.message }
        })));
      }
    });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function callOperation(operation, ...args) {
  return new Promise((resolve) => operation(...args, (...callbackArgs) => resolve(callbackArgs)));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for browser mount state.');
}

test('safeMountName removes path traversal and shell characters', () => {
  assert.strictEqual(safeMountName('../../My Project; touch nope'), 'My-Project-touch-nope');
  assert.strictEqual(safeMountName(''), 'local-folder');
});

test('lazy mount transfers file content only when FUSE reads it', async (t) => {
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-mount-test-'));
  const operations = [];
  const fileContent = Buffer.from('hello from the browser\n');
  const manager = new BrowserMountManager({
    Fuse: FakeFuse,
    platform: 'linux',
    mountRoot,
    requestTimeoutMs: 1000
  });
  t.after(async () => {
    await manager.stopAll();
    fs.rmSync(mountRoot, { recursive: true, force: true });
  });

  const created = manager.createSession('Local Project');
  const session = manager.sessions.get(created.id);
  const socket = new FakeSocket(async (request) => {
    operations.push(request);
    if (request.op === 'getattr' && request.path === '/') return { kind: 'directory', mtime: 1 };
    if (request.op === 'getattr' && request.path === '/hello.txt') return { kind: 'file', size: fileContent.length, mtime: 2 };
    if (request.op === 'readdir') return { names: ['hello.txt'] };
    if (request.op === 'open') return {};
    if (request.op === 'read') {
      const data = fileContent.subarray(request.position, request.position + request.length);
      return { data: data.toString('base64') };
    }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  });

  manager.attachSocket(session, socket);
  await waitFor(() => session.state === 'mounted');
  assert.strictEqual(operations.length, 0, 'mounting itself must not request names, metadata, or file bytes');

  const [readdirError, names] = await callOperation(session.fuse.operations.readdir, '/');
  assert.strictEqual(readdirError, 0);
  assert.deepStrictEqual(names, ['hello.txt']);
  assert.deepStrictEqual(operations.map((request) => request.op), ['readdir']);

  const [getattrError, stat] = await callOperation(session.fuse.operations.getattr, '/hello.txt');
  assert.strictEqual(getattrError, 0);
  assert.strictEqual(stat.size, fileContent.length);
  assert.strictEqual(stat.mode, 0o100444);
  assert.deepStrictEqual(operations.map((request) => request.op), ['readdir', 'getattr']);

  const target = Buffer.alloc(5);
  const [bytesRead] = await callOperation(session.fuse.operations.read, '/hello.txt', 0, target, target.length, 6);
  assert.strictEqual(bytesRead, 5);
  assert.strictEqual(target.toString(), 'from ');
  assert.deepStrictEqual(operations.map((request) => request.op), ['readdir', 'getattr', 'read']);
  assert.strictEqual(operations.at(-1).position, 6);
  assert.strictEqual(operations.at(-1).length, 5);
});

test('mount is read-only and disconnect unmounts it', async (t) => {
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-mount-ro-test-'));
  const manager = new BrowserMountManager({ Fuse: FakeFuse, platform: 'linux', mountRoot });
  t.after(async () => {
    await manager.stopAll();
    fs.rmSync(mountRoot, { recursive: true, force: true });
  });
  const created = manager.createSession('read-only');
  const session = manager.sessions.get(created.id);
  const socket = new FakeSocket(async () => ({ kind: 'file', size: 1, mtime: 1 }));
  manager.attachSocket(session, socket);
  await waitFor(() => session.state === 'mounted');

  const [writeError] = await callOperation(session.fuse.operations.write, '/file', 0, Buffer.from('x'), 1, 0);
  assert.strictEqual(writeError, FakeFuse.EROFS);

  socket.close();
  await waitFor(() => !manager.sessions.has(created.id));
  assert.strictEqual(session.fuse, null);
});
