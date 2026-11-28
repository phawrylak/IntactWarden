/**
 * The network plumbing the Firefox scenarios depend on, checked without a browser: a CONNECT tunnel
 * through the e2e proxy to `api.github.com:443` reaches the local GitHub mirror over TLS with the
 * throw-away certificate (SNI and Host routing, GitHub's CORS headers, the listed asset digest),
 * the release download answers its 302 to release-assets, and any other host is refused.
 */

import {request as httpRequest} from 'node:http';
import type {Socket} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {E2E_ENABLED} from './env.ts';
import {startGitHubMirror, GITHUB_MIRROR_HOSTS, type GitHubMirror} from './server/github.ts';
import {startMappedNetwork, type MappedNetwork} from './server/proxy.ts';
import {vaultwardenRelease} from './server/releases.ts';

function tunnel(proxyPort: number, target: string): Promise<{status: number; socket: Socket}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target});
    req.on('connect', (res, socket) => resolve({status: res.statusCode ?? 0, socket}));
    req.on('error', reject);
    req.end();
  });
}

/** One HTTP/1.1 GET over TLS through the proxy; returns status, headers and body. */
async function httpsViaProxy(
  net: MappedNetwork,
  host: string,
  path: string,
  accept?: string,
): Promise<{status: number; headers: Record<string, string>; body: string}> {
  const {status, socket} = await tunnel(net.proxy.port, `${host}:443`);
  if (status !== 200) return {status, headers: {}, body: ''};
  const tls = tlsConnect({socket, servername: host, ca: net.caCert});
  await new Promise<void>((resolve, reject) => {
    tls.once('secureConnect', () => resolve());
    tls.once('error', reject);
  });
  const extra = accept === undefined ? '' : `Accept: ${accept}\r\n`;
  tls.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);
  const chunks: Buffer[] = [];
  for await (const c of tls) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  const [statusLine, ...lines] = text.slice(0, split).split('\r\n');
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const c = l.indexOf(':');
    headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim();
  }
  return {status: Number(statusLine!.split(' ')[1]), headers, body: text.slice(split + 4)};
}

describe.runIf(E2E_ENABLED)('e2e network plumbing (no browser)', () => {
  let mirror: GitHubMirror;
  let net: MappedNetwork;

  beforeAll(async () => {
    mirror = await startGitHubMirror();
    net = await startMappedNetwork(new Map(GITHUB_MIRROR_HOSTS.map(h => [h, mirror.handler])));
  });

  afterAll(async () => {
    await net?.close();
    await mirror?.close();
  });

  it('api.github.com through the proxy: TLS with the test CA, CORS, the listed digest', async () => {
    const vw = await vaultwardenRelease();
    const r = await httpsViaProxy(
      net,
      'api.github.com',
      `/repositories/${vw.lock.release.repo_id}/releases/tags/${vw.lock.release.tag}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-expose-headers']).toContain('ETag');
    const release = JSON.parse(r.body) as {assets: {name: string; digest: string}[]};
    expect(release.assets.find(a => a.name === vw.lock.release.asset)?.digest).toBe(
      `sha256:${vw.lock.release.sha256}`,
    );
  });

  it('an asset download through the API answers 302 to release-assets, with CORS', async () => {
    const vw = await vaultwardenRelease();
    const {repo_id: repoId, tag, asset: name} = vw.lock.release;
    const listed = await httpsViaProxy(
      net,
      'api.github.com',
      `/repositories/${repoId}/releases/tags/${tag}`,
    );
    const release = JSON.parse(listed.body) as {assets: {id: number; name: string}[]};
    const id = release.assets.find(a => a.name === name)!.id;
    const r = await httpsViaProxy(
      net,
      'api.github.com',
      `/repositories/${repoId}/releases/assets/${id}`,
      'application/octet-stream',
    );
    expect(r.status).toBe(302);
    expect(r.headers['access-control-allow-origin']).toBe('*');
    const file = await httpsViaProxy(
      net,
      'release-assets.githubusercontent.com',
      new URL(r.headers['location']!).pathname,
    );
    expect(file.status).toBe(200);
    expect(file.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('raw files answer with CORS', async () => {
    const r = await httpsViaProxy(net, 'raw.githubusercontent.com', '/no/such/file');
    expect(r.headers['access-control-allow-origin']).toBe('*');
  });

  it('every other host is refused at the proxy', async () => {
    const r = await tunnel(net.proxy.port, 'example.org:443');
    r.socket.destroy();
    expect(r.status).toBe(403);
    expect(net.refused).toContain('example.org:443');
  });
});
