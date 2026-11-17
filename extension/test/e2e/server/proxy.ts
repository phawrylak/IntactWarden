/**
 * Network plumbing for the e2e suite: a TLS endpoint with a test-only certificate for the
 * GitHub host names (and the cloud vault origins, when a cloud emulator is mounted), and an HTTP
 * CONNECT proxy that Firefox uses for every non-loopback request. The proxy tunnels only the mapped
 * hosts, to the local TLS endpoint, and refuses everything else, so the test browser never reaches
 * the internet and production code runs unchanged against `https://api.github.com/...`.
 *
 * The certificate is generated at test time with the system `openssl` (a throw-away CA valid for
 * two days, in a temporary directory). Firefox accepts it through the WebDriver capability
 * `acceptInsecureCerts`.
 */

import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer as createHttpServer, type IncomingMessage} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {connect, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {listen, type Handler, type Listening} from './http.ts';

const run = promisify(execFile);

export interface TestCertificate {
  readonly dir: string;
  readonly caCert: string;
  readonly key: string;
  readonly cert: string;
}

/** A throw-away CA and a leaf certificate for `hosts` (system openssl). */
export async function makeCertificate(hosts: readonly string[]): Promise<TestCertificate> {
  const dir = await mkdtemp(join(tmpdir(), 'iw-e2e-tls-'));
  const p = (n: string): string => join(dir, n);
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  await run('openssl', [
    'req',
    '-x509',
    ...ec,
    '-keyout',
    p('ca.key'),
    '-out',
    p('ca.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=IntactWarden e2e throw-away CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  await run('openssl', [
    'req',
    ...ec,
    '-keyout',
    p('leaf.key'),
    '-out',
    p('leaf.csr'),
    '-subj',
    '/CN=intactwarden-e2e',
  ]);
  await writeFile(
    p('leaf.ext'),
    [
      `subjectAltName=${hosts.map(h => `DNS:${h}`).join(',')}`,
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  );
  await run('openssl', [
    'x509',
    '-req',
    '-in',
    p('leaf.csr'),
    '-CA',
    p('ca.crt'),
    '-CAkey',
    p('ca.key'),
    '-CAcreateserial',
    '-out',
    p('leaf.crt'),
    '-days',
    '2',
    '-extfile',
    p('leaf.ext'),
  ]);
  return {
    dir,
    caCert: await readFile(p('ca.crt'), 'utf8'),
    key: await readFile(p('leaf.key'), 'utf8'),
    cert: (await readFile(p('leaf.crt'), 'utf8')) + (await readFile(p('ca.crt'), 'utf8')),
  };
}

export interface MappedNetwork {
  /** The CONNECT proxy (Firefox prefs network.proxy.ssl / network.proxy.http). */
  readonly proxy: Listening;
  /** The TLS endpoint behind it. */
  readonly tls: Listening;
  /** CONNECT targets refused (host:port), for diagnostics. */
  readonly refused: string[];
  /** PEM of the throw-away CA that signed the TLS endpoint's certificate. */
  readonly caCert: string;
  close(): Promise<void>;
}

/**
 * Starts the TLS endpoint (routing each request by its Host to `routes`) and the proxy that tunnels
 * `<host>:443` for exactly the hosts of `routes`.
 */
export async function startMappedNetwork(
  routes: ReadonlyMap<string, Handler>,
): Promise<MappedNetwork> {
  const certificate = await makeCertificate([...routes.keys()]);
  const tls = await listen(
    async (req, res) => {
      const host = String(req.headers.host ?? '')
        .replace(/:\d+$/, '')
        .toLowerCase();
      const route = routes.get(host);
      if (route === undefined) {
        res.writeHead(421, {'content-type': 'text/plain'});
        res.end('misdirected');
        return;
      }
      await route(req, res);
    },
    createHttpsServer({key: certificate.key, cert: certificate.cert}),
  );
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  const proxyServer = createHttpServer();
  proxyServer.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = req.url ?? '';
    const colon = target.lastIndexOf(':');
    const host = target.slice(0, colon).toLowerCase();
    const port = target.slice(colon + 1);
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    if (port !== '443' || !routes.has(host)) {
      refused.push(target);
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(tls.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
  });
  // Plain-HTTP proxy requests (absolute URLs) are refused: nothing in the suite needs them.
  const proxy = await listen((req, res) => {
    refused.push(`${req.method ?? 'GET'} ${req.url ?? ''}`);
    res.writeHead(403, {'content-type': 'text/plain'});
    res.end('refused by the e2e proxy');
  }, proxyServer);
  return {
    proxy,
    tls,
    refused,
    caCert: certificate.caCert,
    close: async () => {
      for (const s of sockets) s.destroy();
      await proxy.close();
      await tls.close();
      await rm(certificate.dir, {recursive: true, force: true});
    },
  };
}
