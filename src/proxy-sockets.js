import crypto from 'node:crypto';

function socketErrorPayload(req, context, connectionId, side, error) {
  return {
    event: 'proxy_socket_error',
    connectionId,
    side,
    route: context.route,
    target: context.target,
    host: String(req.headers.host || ''),
    path: String(req.url || '/'),
    code: error?.code || '',
    message: error?.message || String(error || 'socket error')
  };
}
export function guardProxySockets(req, client, upstream, context, logger = console.warn) {
  const connectionId = crypto.randomUUID().slice(0, 8);
  let failed = false;

  const closePair = (side, error) => {
    if (failed) return;
    failed = true;
    logger(`[proxy] ${JSON.stringify(socketErrorPayload(req, context, connectionId, side, error))}`);

    if (side === 'upstream' && !client.destroyed && client.writable) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    } else if (!client.destroyed) {
      client.destroy();
    }
    if (!upstream.destroyed) upstream.destroy();
  };

  client.on('error', (error) => closePair('client', error));
  upstream.on('error', (error) => closePair('upstream', error));
  client.on('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
  upstream.on('close', () => {
    if (!client.destroyed) client.destroy();
  });

  return {
    connectionId,
    bridge() {
      client.pipe(upstream).pipe(client);
    }
  };
}
