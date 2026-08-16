import { spawn } from 'node:child_process';

const tunnels = new Map();

export function startFrpTunnel(port, log = console.log) {
  const script = process.env.FRP_TUNNEL_CLIENT_PATH;
  const prefix = process.env.AGENT_TUNNEL_PREFIX;
  if (!script || !prefix || process.platform === 'win32' || tunnels.has(port)) return;
  const name = `${prefix}-${port}`;
  const child = spawn(script, [`127.0.0.1:${port}`, name], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  child.unref();
  tunnels.set(port, child);
  child.once('exit', () => tunnels.delete(port));
  child.once('error', (error) => {
    tunnels.delete(port);
    log(`FRP tunnel ${name} failed: ${error.message}`);
  });
  log(`FRP tunnel: https://${name}.agentsweb.space`);
}

export function stopFrpTunnel(port) {
  const child = tunnels.get(port);
  if (!child) return;
  tunnels.delete(port);
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
}
