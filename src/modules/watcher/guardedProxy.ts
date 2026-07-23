import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as netConnect, type Socket } from 'node:net';
import { pinPublicHost, safeFetch } from '../../security.js';

/**
 * A loopback-only forward proxy that applies the SSRF guard to every request
 * the screenshot browser makes — the *initial* navigation, every redirect, and
 * every sub-resource. Chrome does its own DNS resolution, so pointing it at
 * this proxy (and forbidding the loopback bypass) is the only way to guarantee
 * it connects to a validated, pinned IP rather than a rebinding target.
 *
 * HTTPS (CONNECT): validate the host, then tunnel raw bytes to the pinned IP.
 * TLS still terminates in Chrome against the real hostname, so certificate
 * validation is unaffected.
 *
 * HTTP (absolute-form request): route through `safeFetch`, which pins the IP
 * and re-validates each redirect hop, then stream the response back.
 */
export interface GuardedProxy {
  port: number;
  close(): Promise<void>;
}

export async function startGuardedProxy(): Promise<GuardedProxy> {
  const server = createServer((req, res) => void handleHttp(req, res));
  // Node types the CONNECT socket as a bare Duplex; at runtime it is a net.Socket.
  server.on('connect', (req, socket, head) => void handleConnect(req, socket as Socket, head));
  // Never let a socket error crash the process — the screenshot is best-effort.
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handleConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
  client.on('error', () => client.destroy());
  const [rawHost, rawPort] = (req.url ?? '').split(':');
  const port = Number(rawPort) || 443;
  let upstream: Socket;
  try {
    const pin = await pinPublicHost(rawHost, port);
    upstream = netConnect(port, pin.address);
  } catch {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  upstream.on('error', () => {
    client.destroy();
    upstream.destroy();
  });
  upstream.on('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = req.url ?? '';
  // Only absolute-form proxy requests are valid here (Chrome sends the full URL).
  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const upstream = await safeFetch(target, {
      method: req.method,
      headers: { 'user-agent': req.headers['user-agent'] ?? '', accept: req.headers.accept ?? '*/*' },
    });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      // Drop hop-by-hop headers; let Node frame the response itself.
      if (!/^(transfer-encoding|connection|keep-alive)$/i.test(k)) headers[k] = v;
    });
    res.writeHead(upstream.status, headers);
    if (upstream.body) {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    }
    res.end();
  } catch {
    res.writeHead(403).end();
  }
}
