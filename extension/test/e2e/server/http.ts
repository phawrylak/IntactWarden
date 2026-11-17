/**
 * Small HTTP helpers shared by the e2e fixture servers: listening on 127.0.0.1 with an ephemeral
 * port, a request log (path and status only, never a query string), content types by extension.
 */

import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface Listening {
  readonly server: Server;
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly log: LoggedRequest[];
  close(): Promise<void>;
}

/** Path of a request target without the query string. */
export function pathOf(req: IncomingMessage): string {
  const target = req.url ?? '/';
  const q = target.indexOf('?');
  return q < 0 ? target : target.slice(0, q);
}

export async function listen(
  handler: Handler,
  server: Server = createServer(),
): Promise<Listening> {
  const log: LoggedRequest[] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    res.on('finish', () =>
      log.push({method: req.method ?? 'GET', path: pathOf(req), status: res.statusCode}),
    );
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e: unknown) => {
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
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json',
};

export function contentTypeOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash) return 'application/octet-stream';
  return TYPES[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

export async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

export function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body?: Uint8Array | string,
): void {
  const bytes =
    body === undefined ? undefined : typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, {
    ...headers,
    ...(bytes !== undefined ? {'content-length': String(bytes.length)} : {}),
  });
  res.end(bytes);
}
