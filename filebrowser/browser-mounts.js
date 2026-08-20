const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const SESSION_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SESSIONS = 4;
const MAX_READ_SIZE = 128 * 1024;

function loadFuse(platform = process.platform) {
  if (platform !== 'linux') {
    return { Fuse: null, error: `Browser folder mounts are supported on Linux workers only (this worker is ${platform}).` };
  }
  if (!fs.existsSync('/dev/fuse')) {
    return { Fuse: null, error: 'Browser folder mounts require /dev/fuse on this Linux worker.' };
  }
  try {
    fs.accessSync('/dev/fuse', fs.constants.R_OK | fs.constants.W_OK);
    return { Fuse: require('@cocalc/fuse-native'), error: '' };
  } catch (error) {
    return { Fuse: null, error: `FUSE support is unavailable: ${error.message}` };
  }
}

function safeMountName(value) {
  const normalized = String(value || 'local-folder')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return normalized || 'local-folder';
}

function asDate(value) {
  const date = new Date(Number(value) || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function statFromRemote(remote) {
  const isDirectory = remote.kind === 'directory';
  const timestamp = asDate(remote.mtime);
  return {
    mtime: timestamp,
    atime: timestamp,
    ctime: timestamp,
    nlink: isDirectory ? 2 : 1,
    size: isDirectory ? 4096 : Math.max(0, Number(remote.size) || 0),
    mode: isDirectory ? 0o40555 : 0o100444,
    uid: process.getuid ? process.getuid() : 0,
    gid: process.getgid ? process.getgid() : 0
  };
}

class BrowserMountManager {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    const loaded = options.Fuse
      ? { Fuse: options.Fuse, error: '' }
      : loadFuse(this.platform);
    this.Fuse = loaded.Fuse;
    this.supportError = options.supportError ?? loaded.error;
    this.mountRoot = path.resolve(options.mountRoot || process.env.BROWSER_MOUNT_ROOT || path.join(os.homedir(), 'browser-mounts'));
    this.sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || REQUEST_TIMEOUT_MS;
    this.maxSessions = options.maxSessions || MAX_SESSIONS;
    this.sessions = new Map();
    this.wss = options.WebSocketServer
      ? new options.WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
      : new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  }

  capability() {
    return {
      supported: Boolean(this.Fuse),
      readOnly: true,
      platform: this.platform,
      mountRoot: this.mountRoot,
      error: this.Fuse ? '' : this.supportError
    };
  }

  list() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      name: session.name,
      mountPath: session.mountPath,
      state: session.state,
      createdAt: session.createdAt,
      connectedAt: session.connectedAt || '',
      error: session.error || ''
    }));
  }

  createSession(name) {
    if (!this.Fuse) {
      const error = new Error(this.supportError || 'FUSE support is unavailable.');
      error.statusCode = 501;
      throw error;
    }
    if (this.sessions.size >= this.maxSessions) {
      const error = new Error(`At most ${this.maxSessions} browser folder mounts may be active.`);
      error.statusCode = 429;
      throw error;
    }

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const safeName = safeMountName(name);
    const mountPath = path.join(this.mountRoot, `${safeName}-${id.slice(0, 8)}`);
    const session = {
      id,
      token,
      name: safeName,
      mountPath,
      state: 'waiting',
      error: '',
      createdAt: new Date().toISOString(),
      connectedAt: '',
      socket: null,
      fuse: null,
      mountPromise: null,
      pending: new Map(),
      nextRequestId: 1,
      expiryTimer: null,
      stopping: false
    };
    session.expiryTimer = setTimeout(() => this.stopSession(id, 'Browser did not connect in time.'), this.sessionTtlMs);
    session.expiryTimer.unref?.();
    this.sessions.set(id, session);
    return {
      id,
      token,
      name: safeName,
      mountPath,
      websocketPath: `/api/browser-mounts/${encodeURIComponent(id)}/connect?token=${encodeURIComponent(token)}`
    };
  }

  handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return false;
    }
    const match = url.pathname.match(/^\/api\/browser-mounts\/([^/]+)\/connect$/);
    if (!match) return false;

    const session = this.sessions.get(decodeURIComponent(match[1]));
    const suppliedToken = url.searchParams.get('token') || '';
    const validToken = session
      && session.state === 'waiting'
      && session.token
      && suppliedToken.length === session.token.length
      && crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(session.token));
    if (!validToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return true;
    }

    session.token = '';
    clearTimeout(session.expiryTimer);
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attachSocket(session, ws));
    return true;
  }

  attachSocket(session, socket) {
    if (!session || session.state !== 'waiting') {
      socket.close(1008, 'Mount session is no longer available.');
      return;
    }
    session.socket = socket;
    session.state = 'mounting';
    session.connectedAt = new Date().toISOString();

    socket.on('message', (payload) => this.handleMessage(session, payload));
    socket.once('close', () => this.stopSession(session.id, 'Browser folder disconnected.'));
    socket.once('error', (error) => this.stopSession(session.id, error.message));

    session.mountPromise = this.mount(session);
    session.mountPromise.catch((error) => {
      session.error = error.message;
      this.sendState(session, 'error', error.message);
      this.stopSession(session.id, error.message);
    });
  }

  handleMessage(session, payload) {
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload));
    } catch {
      session.socket?.close(1003, 'Expected a JSON filesystem response.');
      return;
    }
    if (message.type !== 'response' || !Number.isInteger(message.id)) return;
    const pending = session.pending.get(message.id);
    if (!pending) return;
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result || {});
    else {
      const error = new Error(message.error?.message || 'Browser filesystem operation failed.');
      error.code = message.error?.code || 'EIO';
      pending.reject(error);
    }
  }

  rpc(session, op, args = {}) {
    if (!session.socket || session.socket.readyState !== 1) {
      const error = new Error('Browser folder is disconnected.');
      error.code = 'EIO';
      return Promise.reject(error);
    }
    const id = session.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        const error = new Error(`Browser filesystem ${op} timed out.`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer });
      session.socket.send(JSON.stringify({ type: 'request', id, op, ...args }), (error) => {
        if (!error) return;
        const pending = session.pending.get(id);
        if (!pending) return;
        session.pending.delete(id);
        clearTimeout(timer);
        error.code = 'EIO';
        reject(error);
      });
    });
  }

  errno(error) {
    const code = String(error?.code || '').toUpperCase();
    return this.Fuse[code] || this.Fuse.EIO || -5;
  }

  createOperations(session) {
    const remote = (op, args, cb, transform = (result) => [0, result]) => {
      this.rpc(session, op, args).then(
        (result) => cb(...transform(result)),
        (error) => cb(this.errno(error))
      );
    };
    const rejectWrite = (cb) => process.nextTick(cb, this.Fuse.EROFS || -30);

    return {
      getattr: (remotePath, cb) => remote('getattr', { path: remotePath }, cb, (result) => [0, statFromRemote(result)]),
      fgetattr: (remotePath, _fd, cb) => remote('getattr', { path: remotePath }, cb, (result) => [0, statFromRemote(result)]),
      readdir: (remotePath, cb) => remote('readdir', { path: remotePath }, cb, (result) => [0, Array.isArray(result.names) ? result.names : []]),
      access: (remotePath, mode, cb) => {
        if (mode & 2) return rejectWrite(cb);
        remote('getattr', { path: remotePath }, cb, () => [0]);
      },
      open: (remotePath, flags, cb) => {
        if ((flags & 3) !== 0) return rejectWrite(cb);
        remote('open', { path: remotePath }, cb, () => [0, 0]);
      },
      opendir: (remotePath, _flags, cb) => remote('opendir', { path: remotePath }, cb, () => [0, 0]),
      read: (remotePath, _fd, buffer, length, position, cb) => {
        const requestedLength = Math.min(length, MAX_READ_SIZE);
        this.rpc(session, 'read', { path: remotePath, length: requestedLength, position }).then((result) => {
          const data = Buffer.from(String(result.data || ''), 'base64');
          if (data.length > requestedLength) return cb(this.Fuse.EIO || -5);
          data.copy(buffer, 0, 0, data.length);
          return cb(data.length);
        }, (error) => cb(this.errno(error)));
      },
      release: (_remotePath, _fd, cb) => process.nextTick(cb, 0),
      releasedir: (_remotePath, _fd, cb) => process.nextTick(cb, 0),
      statfs: (_remotePath, cb) => process.nextTick(cb, 0, {
        bsize: 4096,
        frsize: 4096,
        blocks: 1_000_000,
        bfree: 1_000_000,
        bavail: 1_000_000,
        files: 1_000_000,
        ffree: 1_000_000,
        favail: 1_000_000,
        fsid: 0,
        flag: 1,
        namemax: 255
      }),
      create: (_remotePath, _mode, cb) => rejectWrite(cb),
      write: (_remotePath, _fd, _buffer, _length, _position, cb) => rejectWrite(cb),
      truncate: (_remotePath, _size, cb) => rejectWrite(cb),
      ftruncate: (_remotePath, _fd, _size, cb) => rejectWrite(cb),
      chmod: (_remotePath, _mode, cb) => rejectWrite(cb),
      chown: (_remotePath, _uid, _gid, cb) => rejectWrite(cb),
      unlink: (_remotePath, cb) => rejectWrite(cb),
      rename: (_source, _destination, cb) => rejectWrite(cb),
      mkdir: (_remotePath, _mode, cb) => rejectWrite(cb),
      rmdir: (_remotePath, cb) => rejectWrite(cb)
    };
  }

  async mount(session) {
    await fs.promises.mkdir(this.mountRoot, { recursive: true, mode: 0o700 });
    const fuse = new this.Fuse(session.mountPath, this.createOperations(session), {
      mkdir: true,
      force: true,
      autoUnmount: true,
      fsname: `browser:${session.name}`,
      subtype: 'worker-agents-browser',
      maxRead: MAX_READ_SIZE,
      entryTimeout: 1,
      attrTimeout: 1,
      timeout: this.requestTimeoutMs + 2_000
    });
    session.fuse = fuse;
    await new Promise((resolve, reject) => fuse.mount((error) => error ? reject(error) : resolve()));
    if (session.stopping) {
      await this.unmountFuse(session);
      return;
    }
    session.state = 'mounted';
    this.sendState(session, 'mounted');
  }

  sendState(session, state, error = '') {
    if (!session.socket || session.socket.readyState !== 1) return;
    session.socket.send(JSON.stringify({
      type: 'state',
      state,
      mountPath: session.mountPath,
      readOnly: true,
      error
    }));
  }

  async unmountFuse(session) {
    if (!session.fuse) return;
    const fuse = session.fuse;
    session.fuse = null;
    await new Promise((resolve) => fuse.unmount(() => resolve()));
    await fs.promises.rmdir(session.mountPath).catch(() => {});
  }

  async stopSession(id, reason = '') {
    const session = this.sessions.get(id);
    if (!session || session.stopping) return;
    session.stopping = true;
    session.state = 'stopping';
    session.error = reason;
    clearTimeout(session.expiryTimer);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      const error = new Error(reason || 'Browser folder mount stopped.');
      error.code = 'EIO';
      pending.reject(error);
    }
    session.pending.clear();
    if (session.mountPromise) await session.mountPromise.catch(() => {});
    await this.unmountFuse(session);
    if (session.socket && session.socket.readyState < 2) {
      session.socket.close(1000, reason || 'Mount stopped.');
    }
    this.sessions.delete(id);
  }

  async stopAll() {
    await Promise.all(Array.from(this.sessions.keys()).map((id) => this.stopSession(id, 'File Browser is stopping.')));
    this.wss.close();
  }
}

module.exports = {
  BrowserMountManager,
  MAX_READ_SIZE,
  safeMountName,
  statFromRemote
};
