/**
 * Content codings, reproducible from the repository. A small Node
 * front server re-encodes every 200 response of the Vaultwarden fixture site (asked for
 * `Accept-Encoding: identity`) before Firefox sees it:
 *
 * - `deflate`: `Content-Encoding: deflate` (the zlib format, RFC 9110 §8.4.1.2), with a length;
 * - `gzip`, `br`, `zstd`: one coding each, with a length;
 * - `gzip, br`: gzip, then Brotli over the gzip bytes, `Content-Encoding: gzip, br` (stacked codings,
 *   listed in the order applied);
 * - `chunked`: no coding, `Transfer-Encoding: chunked` and no `Content-Length`, in 4 KB writes;
 * - and one self-hosted instance over https and HTTP/2 (`https://127.0.0.1:<port>`, a throw-away
 *   certificate accepted through `acceptInsecureCerts`), gzip on the fly.
 *
 * Each runs as its own instance (its own port) and must be VERIFIED with the release-exact binding,
 * every script verified and the server stylesheet accepted: the StreamFilter sees decoded bytes.
 */

import {request as httpRequest, type IncomingHttpHeaders} from 'node:http';
import {createSecureServer, type Http2Session} from 'node:http2';
import type {AddressInfo} from 'node:net';
import {rm} from 'node:fs/promises';
import {brotliCompressSync, deflateSync, gzipSync, zstdCompressSync} from 'node:zlib';
import {expect} from 'vitest';
import {
  addInstance,
  allScriptsOk,
  expectPrivateStorage,
  waitForState,
  type Scenario,
} from './scenarios.ts';
import {listen} from './server/http.ts';
import {makeCertificate} from './server/proxy.ts';
import {startVaultwarden, type Site} from './server/sites.ts';

export type FrontCoding = 'deflate' | 'gzip' | 'br' | 'zstd' | 'gzip, br' | 'chunked';

export const FRONT_CODINGS: readonly FrontCoding[] = [
  'deflate',
  'gzip',
  'br',
  'zstd',
  'gzip, br',
  'chunked',
];

const ENCODERS: Readonly<Record<Exclude<FrontCoding, 'chunked'>, (b: Uint8Array) => Uint8Array>> = {
  deflate: b => deflateSync(b),
  gzip: b => gzipSync(b),
  br: b => brotliCompressSync(b),
  zstd: b => zstdCompressSync(b),
  'gzip, br': b => brotliCompressSync(gzipSync(b)),
};

/** Response headers the front server never copies from the fixture site. */
const HOP: ReadonlySet<string> = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

export interface FrontServer {
  readonly port: number;
  /** `http://127.0.0.1:<port>`, or `https://…` for the TLS front. */
  readonly origin: string;
  /** `Content-Encoding` (or `chunked`) of every response sent, by path. */
  readonly sent: Map<string, string>;
  /** HTTP versions of the requests received (`1.1`, `2.0`). */
  readonly versions: Set<string>;
  /** `<status> <path>` of every response other than a 200 (for the failure message). */
  readonly other: string[];
  setUpstream(origin: string): void;
  close(): Promise<void>;
}

/** The body as `coding` puts it on the wire, with the headers that say so. */
export function encodeBody(
  coding: FrontCoding,
  body: Uint8Array,
): {headers: Record<string, string>; chunks: Uint8Array[]} {
  if (coding !== 'chunked') {
    const out = ENCODERS[coding](body);
    return {
      headers: {'content-encoding': coding, 'content-length': String(out.length)},
      chunks: [out],
    };
  }
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < body.length; i += 4096) chunks.push(body.subarray(i, i + 4096));
  return {headers: {}, chunks};
}

type FrontRequest = {
  readonly url?: string;
  readonly method?: string;
  readonly httpVersion: string;
  readonly headers: IncomingHttpHeaders;
};
type FrontResponse = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: Uint8Array): unknown;
  end(): unknown;
  end(body: Uint8Array): unknown;
};

/**
 * A front server on 127.0.0.1 that re-encodes the fixture site's responses with `coding`; with
 * `tls`, over https with HTTP/2 (HTTP/1.1 is still accepted, and `versions` says which was used).
 */
export async function startFront(
  coding: FrontCoding,
  options: {tls?: boolean} = {},
): Promise<FrontServer> {
  let upstream = '';
  const sent = new Map<string, string>();
  const versions = new Set<string>();
  const other: string[] = [];
  const serve = async (req: FrontRequest, res: FrontResponse): Promise<void> => {
    versions.add(req.httpVersion);
    const reqPath = new URL(req.url ?? '/', 'http://x').pathname;
    const target = new URL(req.url ?? '/', upstream);
    const headers: Record<string, string> = {'accept-encoding': 'identity'};
    for (const [k, v] of Object.entries(req.headers)) {
      // HTTP/2 pseudo-headers (":path", ":authority") are not forwarded.
      if (
        typeof v === 'string' &&
        !k.startsWith(':') &&
        !['host', 'accept-encoding', 'connection'].includes(k)
      ) {
        headers[k] = v;
      }
    }
    const answer = await new Promise<{status: number; headers: IncomingHttpHeaders; body: Buffer}>(
      (resolve, reject) => {
        const r = httpRequest(
          target,
          // A fresh connection per request: a reused keep-alive socket that the fixture site has
          // just closed fails with ECONNRESET, which the front would answer with a 500.
          {method: req.method ?? 'GET', headers, agent: false},
          up => {
            const parts: Buffer[] = [];
            up.on('data', (c: Buffer) => parts.push(c));
            up.on('end', () =>
              resolve({
                status: up.statusCode ?? 502,
                headers: up.headers,
                body: Buffer.concat(parts),
              }),
            );
            up.on('error', reject);
          },
        );
        r.on('error', reject);
        r.end();
      },
    );
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer.headers)) {
      if (typeof v === 'string' && !HOP.has(k)) out[k] = v;
    }
    if (answer.headers['content-encoding'] !== undefined) {
      throw new Error(`the fixture site answered ${target.pathname} with a content coding`);
    }
    const path = target.pathname;
    if (answer.status !== 200 || req.method === 'HEAD' || answer.body.length === 0) {
      if (answer.status !== 200) other.push(`${answer.status} ${reqPath}`);
      res.writeHead(answer.status, {...out, 'content-length': String(answer.body.length)});
      if (req.method === 'HEAD') res.end();
      else res.end(answer.body);
      return;
    }
    const encoded = encodeBody(coding, new Uint8Array(answer.body));
    res.writeHead(200, {...out, ...encoded.headers});
    for (const c of encoded.chunks) res.write(c);
    res.end();
    sent.set(path, coding);
  };
  const handle = (req: FrontRequest, res: FrontResponse): Promise<void> =>
    serve(req, res).catch((e: unknown) => {
      other.push(`error ${req.url ?? ''}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
  if (options.tls !== true) {
    const front = await listen(handle);
    return {
      port: front.port,
      origin: front.origin,
      sent,
      versions,
      other,
      setUpstream: origin => void (upstream = origin),
      close: () => front.close(),
    };
  }
  const certificate = await makeCertificate(['localhost']);
  const server = createSecureServer({
    key: certificate.key,
    cert: certificate.cert,
    allowHTTP1: true,
  });
  const sessions = new Set<Http2Session>();
  server.on('session', session => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('request', (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500, {'content-type': 'text/plain'});
      res.end(`fixture error: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `https://127.0.0.1:${port}`,
    sent,
    versions,
    other,
    setUpstream: origin => void (upstream = origin),
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(certificate.dir, {recursive: true, force: true});
    },
  };
}

/** The fronts of the scenario: every coding over plain HTTP, and gzip over https with HTTP/2. */
const FRONTS: readonly {coding: FrontCoding; tls: boolean}[] = [
  ...FRONT_CODINGS.map(coding => ({coding, tls: false})),
  {coding: 'gzip', tls: true},
];

export const ENCODING_SCENARIOS: readonly Scenario[] = [
  {
    id: 'vw-content-encodings',
    title:
      'Vaultwarden served with Content-Encoding deflate, gzip, br, zstd, stacked "gzip, br", ' +
      'chunked without Content-Length, and gzip over https with HTTP/2 (a Node front server) → ' +
      'VERIFIED in each (decoded bytes)',
    pkg: 'full',
    async run(d) {
      const lines: string[] = [];
      for (const {coding, tls} of FRONTS) {
        const front = await startFront(coding, {tls});
        let site: Site | null = null;
        try {
          site = await startVaultwarden({publicOrigin: front.origin});
          front.setUpstream(site.origin);
          const view: Site = {...site, origin: front.origin, port: front.port};
          // The test package holds the http loopback hosts only; an https instance asks.
          if (tls) await d.grantHosts!(['https://127.0.0.1/*']);
          const {instance} = await addInstance(d, view);
          expect(instance).toMatchObject({app: 'vaultwarden-web', base_path: '/'});
          const tab = await d.open(`${front.origin}/#/login`);
          const t = await waitForState(
            d,
            tab,
            'VERIFIED',
            s => s.top?.serverStyle !== null && allScriptsOk(s),
            60_000,
          ).catch((e: unknown) => {
            const other = front.other.length === 0 ? 'none' : front.other.join(', ');
            throw new Error(
              `${coding}${tls ? ' over https' : ''}: ${String(e)}; front non-200: ${other}`,
            );
          });
          expect(t.top).toMatchObject({
            binding: {buildId: 'vaultwarden-web@2026.10.1+release', assurance: 'release-exact'},
            serverStyle: {accepted: true},
          });
          const main = site.mainScript;
          expect(front.sent.get('/')).toBe(coding);
          expect(front.sent.get(main)).toBe(coding);
          if (tls) expect([...front.versions]).toContain('2.0');
          const how =
            coding === 'chunked'
              ? 'chunked without Content-Length'
              : `with Content-Encoding: ${coding}`;
          const over = tls ? ` over https (HTTP ${[...front.versions].sort().join(', ')})` : '';
          lines.push(
            `${coding}${over}: ${front.sent.size} responses (/ and ${main} among them) sent ${how}; ` +
              `state ${t.state}, binding ${t.top!.binding!.buildId} (${t.top!.binding!.assurance}), ` +
              `scripts ${t.top!.counts.scripts.ok}/${t.top!.counts.scripts.total}, styles ` +
              `${t.top!.counts.styles.ok}/${t.top!.counts.styles.total}, server style accepted`,
          );
        } finally {
          await site?.close();
          await front.close();
        }
      }
      lines.push(await expectPrivateStorage(d));
      return lines;
    },
  },
];
