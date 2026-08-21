const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const TEST_PORT = 3847;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${TEST_PORT}${path}`, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null, raw: data });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForServer(proc, logs) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Server exited before tests ran:\n${logs}`);
    }
    try {
      const res = await request('/api/files');
      if (res.status === 200) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready on :${TEST_PORT}\n${logs}`);
}

async function runTests() {
  console.log('Running automated backend sanity verification...');

  const storageRoot = path.resolve(process.env.STORAGE_DIR || '/');
  const appRel = path.relative(storageRoot, __dirname);
  const appRelParts = appRel ? appRel.split(path.sep) : [];
  const browsePath = appRelParts.length ? `/browse/${encodeURIComponent([...appRelParts, 'work'].join('/'))}` : '/browse/work';
  const editPath = appRelParts.length ? `/edit/${encodeURIComponent([...appRelParts, 'README.md'].join('/'))}` : '/edit/README.md';

  // 1. List files API
  const filesRes = await request('/api/files');
  assert.strictEqual(filesRes.status, 200, 'API /api/files should return 200');
  assert.ok(Array.isArray(filesRes.data.items), 'items should be an array');
  console.log('✔ /api/files API works correctly');

  // 0b. Default start path should point at the user's home dir
  const startRes = await request('/api/start');
  assert.strictEqual(startRes.status, 200, 'API /api/start should return 200');
  assert.strictEqual(typeof startRes.data.path, 'string', 'start path should be a string');
  const home = os.homedir();
  const expectedStart = process.env.START_DIR ? path.resolve(process.env.START_DIR) : home;
  assert.strictEqual(
    path.resolve(storageRoot, startRes.data.path),
    path.resolve(expectedStart),
    `start path should point at ${expectedStart}`
  );
  console.log(`✔ /api/start returns home start path (${startRes.data.path || '(root)'})`);

  // 2. Check Explorer root and route contract
  const explorerRes = await request('/');
  assert.strictEqual(explorerRes.status, 200, 'GET / should return Explorer');
  assert.ok(explorerRes.raw.includes('File Explorer'), 'Explorer UI should render at /');

  const browseRes = await request(browsePath);
  assert.strictEqual(browseRes.status, 200, 'GET /browse should return Explorer');

  const editRes = await request(editPath);
  assert.strictEqual(editRes.status, 200, 'GET /edit/README.md should return Explorer');

  const finderRes = await request('/finder');
  assert.strictEqual(finderRes.status, 404, '/finder should be removed');

  // 3. Default mode must serve the whole filesystem, not just $HOME
  if (!process.env.STORAGE_DIR) {
    const rootFiles = await request('/api/files');
    assert.strictEqual(rootFiles.status, 200, 'filesystem root should be listable');
    const names = (rootFiles.data.items || []).map((i) => i.name);
    assert.ok(names.includes('etc'), 'root listing should include /etc');
    const sysRead = await request('/api/read?path=etc/hosts');
    assert.strictEqual(sysRead.status, 200, 'system files outside $HOME must be readable');
    assert.ok(sysRead.data.content.includes('127.0.0.1'), '/etc/hosts should contain the loopback entry');
    console.log('✔ Full system access confirmed (root listing + /etc/hosts)');
  }

  console.log('✔ All backend endpoints verified successfully.');
}

async function main() {
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  serverProc.stdout.on('data', (d) => (logs += d));
  serverProc.stderr.on('data', (d) => (logs += d));
  try {
    await waitForServer(serverProc, logs);
    await runTests();
    console.log('✔ npm test completed.');
  } finally {
    serverProc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
