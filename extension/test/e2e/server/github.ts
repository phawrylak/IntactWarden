/**
 * A local mirror of the GitHub endpoints that local deep verify uses (api.github.com release,
 * git-ref and tag-object JSON by repository id, with asset digests, release downloads with their 302 to
 * release-assets, raw files by commit), serving the cached real release assets. It is the trust
 * tests' emulator (extension/test/trust/helpers/githubEmulator.ts) behind a real HTTP server, so the
 * same responses reach the extension over the network: Firefox reaches it over TLS through the
 * CONNECT proxy (proxy.ts), with the real host names in SNI and `Host`.
 *
 * api.github.com answers with GitHub's CORS headers (the extension reads the rate-limit headers
 * from a background fetch without a host permission). Release-asset downloads can be held until the
 * test releases them, so the amber phase of an unknown build is observable.
 */

import type {IncomingMessage, ServerResponse} from 'node:http';
import {createFakeFetch} from '../../trust/helpers/fakeFetch.ts';
import {createGitHubEmulator, type GitHubEmulator} from '../../trust/helpers/githubEmulator.ts';
import type {Handler} from './http.ts';
import {bitwardenRelease, vaultwardenRelease} from './releases.ts';

export const GITHUB_MIRROR_HOSTS: readonly string[] = Object.freeze([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
]);

const BITWARDEN_REPO_ID = 53538899;

/**
 * A Vaultwarden web-vault release published without its tarball (`v2026.8.0` shipped only in
 * container images): the mirror lists it with sha256sums.txt only.
 */
export const IMAGE_ONLY_VERSION = '2026.8.0';
/**
 * The real tag of that release in dani-garcia/bw_web_builds (commit and annotated tag object).
 */
const IMAGE_ONLY_TAG = Object.freeze({
  commit: 'ac36b681dedf53412fc5519dd812157438a005b8',
  tagObject: '41a50865e3c48350cfe17f22df4bdd193b2e6d0e',
});

const API_CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, ' +
    'X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, ' +
    'X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, X-GitHub-SSO, ' +
    'X-GitHub-Request-Id, Deprecation, Sunset',
};

export interface MirrorRequest {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Privacy evidence: the request's Cookie, Referer and Origin headers (null when absent). */
  readonly cookie: string | null;
  readonly referer: string | null;
  readonly origin: string | null;
}

export interface GitHubMirror {
  /** The request handler, mounted on the TLS endpoint of the proxy. */
  readonly handler: Handler;
  readonly emulator: GitHubEmulator;
  /** Requests answered (host, method, path without query, status, privacy headers). */
  readonly requests: MirrorRequest[];
  /**
   * Hold release-asset downloads (or the requests to `hosts`) until release() (deep verify then
   * stays in progress).
   */
  hold(options?: {readonly hosts?: readonly string[]}): void;
  release(): void;
  close(): Promise<void>;
}

export async function startGitHubMirror(): Promise<GitHubMirror> {
  const fake = createFakeFetch();
  const emulator = createGitHubEmulator(fake);
  const bw = await bitwardenRelease();
  emulator.addRelease({
    repoId: BITWARDEN_REPO_ID,
    repo: bw.lock.release.repo,
    tag: bw.lock.release.tag,
    assets: [{name: bw.lock.release.asset, bytes: bw.zip}],
  });
  emulator.setTag(bw.lock.release.repo, BITWARDEN_REPO_ID, bw.lock.release.tag, {
    commit: bw.lock.release.commit,
  });
  const vw = await vaultwardenRelease();
  emulator.addRelease({
    repoId: vw.lock.release.repo_id,
    repo: vw.lock.release.repo,
    tag: vw.lock.release.tag,
    assets: [
      {name: vw.lock.release.asset, bytes: vw.tarball},
      // The release lists sha256sums.txt next to the tarball; here it names another digest for
      // it. Deep verify never reads it: the tarball's GitHub digest is what counts.
      {
        name: 'sha256sums.txt',
        bytes: new TextEncoder().encode(`${'0'.repeat(64)}  ${vw.lock.release.asset}\n`),
      },
    ],
  });
  emulator.setTag(vw.lock.release.repo, vw.lock.release.repo_id, vw.lock.release.tag, {
    commit: vw.lock.release.commit,
    tagObject: vw.lock.release.tag_object,
  });
  emulator.addRelease({
    repoId: vw.lock.release.repo_id,
    repo: vw.lock.release.repo,
    tag: `v${IMAGE_ONLY_VERSION}`,
    assets: [{name: 'sha256sums.txt', bytes: new TextEncoder().encode('')}],
  });
  emulator.setTag(
    vw.lock.release.repo,
    vw.lock.release.repo_id,
    `v${IMAGE_ONLY_VERSION}`,
    IMAGE_ONLY_TAG,
  );

  const requests: MirrorRequest[] = [];
  let gate: {
    promise: Promise<void>;
    open: () => void;
    hosts: readonly string[];
  } | null = null;

  const handler: Handler = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(req.headers.host ?? '')
      .replace(/:\d+$/, '')
      .toLowerCase();
    const target = req.url ?? '/';
    const path = target.split('?')[0]!;
    const method = req.method ?? 'GET';
    const header = (name: string): string | null => {
      const v = req.headers[name];
      return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
    };
    const privacy = {
      cookie: header('cookie'),
      referer: header('referer'),
      origin: header('origin'),
    };
    res.on('finish', () => requests.push({host, method, path, status: res.statusCode, ...privacy}));
    if (!GITHUB_MIRROR_HOSTS.includes(host)) {
      res.writeHead(421, {'content-type': 'text/plain'});
      res.end('misdirected');
      return;
    }
    if (method === 'OPTIONS' && host === 'api.github.com') {
      res.writeHead(204, {
        ...API_CORS,
        'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
        'access-control-allow-headers':
          'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, ' +
          'If-Unmodified-Since, Accept-Encoding, X-GitHub-OTP, X-Requested-With, User-Agent, ' +
          'GraphQL-Features, X-Github-Next-Global-ID, X-GitHub-Api-Version',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'host') continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const held = gate !== null && gate.hosts.includes(host) ? gate : null;
    if (held !== null) await held.promise;
    let r: Response;
    try {
      r = await fake.fetch(`https://${host}${target}`, {method, headers, redirect: 'manual'});
    } catch {
      res.writeHead(404, {'content-type': 'text/plain'});
      res.end('not found');
      return;
    }
    const out: Record<string, string> = host === 'api.github.com' ? {...API_CORS} : {};
    r.headers.forEach((value, name) => (out[name] = value));
    const bytes = r.body === null ? new Uint8Array() : new Uint8Array(await r.arrayBuffer());
    if (r.status !== 204) out['content-length'] = String(bytes.length);
    res.writeHead(r.status, out);
    res.end(bytes);
  };

  return {
    handler,
    emulator,
    requests,
    hold(options = {}) {
      if (gate !== null) return;
      let open!: () => void;
      const promise = new Promise<void>(resolve => (open = resolve));
      gate = {
        promise,
        open,
        hosts: options.hosts ?? ['release-assets.githubusercontent.com'],
      };
    },
    release() {
      gate?.open();
      gate = null;
    },
    close: async () => {
      gate?.open();
    },
  };
}
