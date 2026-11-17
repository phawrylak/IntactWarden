/**
 * A routing fake of `fetch` for the trust tests (no network): exact-URL
 * routes, redirect following like `redirect: 'follow'`, the final URL set on
 * the Response, abort signals honoured, and every call recorded.
 */

export interface FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | null;
  readonly init: RequestInit;
}

export type FakeHandler = (req: FakeRequest) => Response | Promise<Response>;

export interface FakeFetch {
  readonly fetch: typeof fetch;
  /** Routes `METHOD url` (exact URL, query included) to a handler. */
  route(method: string, url: string, handler: FakeHandler): void;
  /** Fallback for URLs without an exact route (return null to fall through). */
  fallback(handler: (req: FakeRequest) => Response | Promise<Response> | null): void;
  readonly calls: FakeRequest[];
  /** Calls whose URL starts with `prefix`. */
  count(prefix: string, method?: string): number;
  readonly unrouted: string[];
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function withUrl(res: Response, url: string): Response {
  Object.defineProperty(res, 'url', {value: url, configurable: true});
  return res;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function createFakeFetch(): FakeFetch {
  const routes = new Map<string, FakeHandler>();
  const fallbacks: ((req: FakeRequest) => Response | Promise<Response> | null)[] = [];
  const calls: FakeRequest[] = [];
  const unrouted: string[] = [];

  async function one(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const req: FakeRequest = {
      url,
      method,
      headers: new Headers(init.headers),
      body: await bodyBytes(init.body),
      init,
    };
    calls.push(req);
    const handler = routes.get(`${method} ${url}`);
    if (handler !== undefined) return handler(req);
    for (const f of fallbacks) {
      const r = await f(req);
      if (r !== null) return r;
    }
    unrouted.push(`${method} ${url}`);
    throw new TypeError(`fake fetch: no route for ${method} ${url}`);
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signal = init.signal ?? undefined;
    for (let hop = 0; hop < 6; hop++) {
      if (signal?.aborted === true) throw abortError();
      const res = await one(url, init);
      if (isAborted(signal)) throw abortError();
      const location = res.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(res.status) && location !== null) {
        if (init.redirect === 'error') throw new TypeError('fake fetch: redirect refused');
        if (init.redirect === 'manual') return withUrl(res, url);
        url = new URL(location, url).href;
        continue;
      }
      return withUrl(res, url);
    }
    throw new TypeError('fake fetch: too many redirects');
  };

  return {
    fetch: fetchImpl as typeof fetch,
    route(method, url, handler) {
      routes.set(`${method.toUpperCase()} ${url}`, handler);
    },
    fallback(handler) {
      fallbacks.push(handler);
    },
    calls,
    count: (prefix, method) =>
      calls.filter(c => c.url.startsWith(prefix) && (method === undefined || c.method === method))
        .length,
    unrouted,
  };
}

/** A JSON response. */
export function jsonResponse(
  value: unknown,
  init: {status?: number; headers?: Record<string, string>} = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {'content-type': 'application/json', ...init.headers},
  });
}

/** A streamed byte response in chunks; `stallAfter` stops producing after that many chunks. */
export function bytesResponse(
  bytes: Uint8Array,
  init: {
    status?: number;
    headers?: Record<string, string>;
    chunkSize?: number;
    stallAfter?: number;
    signal?: AbortSignal | null;
    onPull?: () => void;
  } = {},
): Response {
  const chunkSize = init.chunkSize ?? 64 * 1024;
  let at = 0;
  let chunks = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      init.onPull?.();
      if (init.stallAfter !== undefined && chunks >= init.stallAfter) {
        // Never resolves until aborted: an idle server.
        return new Promise<void>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()), {once: true});
        });
      }
      if (at >= bytes.length) {
        controller.close();
        return undefined;
      }
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
      chunks++;
      return undefined;
    },
  });
  return new Response(stream, {status: init.status ?? 200, headers: init.headers ?? {}});
}
