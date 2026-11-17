/**
 * A GitHub emulator on top of the fake fetch: the REST release and git-ref
 * endpoints by repository id (with rate limits), release downloads (302 to
 * release-assets), and raw files by commit.
 */

import {createHash} from 'node:crypto';
import {bytesResponse, jsonResponse, type FakeFetch, type FakeRequest} from './fakeFetch.ts';

export interface EmuAsset {
  readonly name: string;
  readonly bytes: Uint8Array;
  /** Listed digest: default the bytes' sha256; null lists none; a string overrides it. */
  readonly digest?: string | null;
  /** Listed size (default: the bytes' length). */
  readonly size?: number;
}

export interface EmuRelease {
  readonly repoId: number;
  readonly repo: string;
  readonly tag: string;
  readonly assets: readonly EmuAsset[];
  readonly draft?: boolean;
  /** The repository name in download URLs (default `repo`): a renamed repository. */
  readonly downloadRepo?: string;
}

export interface EmuTag {
  readonly commit: string;
  readonly tagObject?: string;
}

export interface GitHubEmulator {
  addRelease(release: EmuRelease): void;
  setTag(repo: string, repoId: number, tag: string, value: EmuTag): void;
  setRaw(repo: string, commit: string, path: string, bytes: Uint8Array): void;
  /** Every API request answers 403 with x-ratelimit-remaining 0 until `resetSec` (null: off). */
  rateLimit(resetSec: number | null): void;
  /** Bytes served for a download, if different from the listed asset (tampering); null: the asset. */
  serveInstead(repo: string, tag: string, asset: string, bytes: Uint8Array | null): void;
  readonly counts: {
    api: number;
    download: number;
    raw: number;
  };
}

const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export function createGitHubEmulator(fake: FakeFetch): GitHubEmulator {
  const releases = new Map<string, EmuRelease>(); // `${repoId}/${tag}`
  const tags = new Map<string, EmuTag & {repoId: number}>(); // `${repo}/${tag}` (lowercase repo)
  const raw = new Map<string, Uint8Array>();
  const replaced = new Map<string, Uint8Array>();
  let rateLimitReset: number | null = null;
  const counts = {api: 0, download: 0, raw: 0};

  const releaseJson = (r: EmuRelease): unknown => ({
    id: 1,
    tag_name: r.tag,
    draft: r.draft === true,
    prerelease: false,
    immutable: true,
    body: 'release notes',
    assets: r.assets.map(a => ({
      name: a.name,
      size: a.size ?? a.bytes.length,
      state: 'uploaded',
      digest: a.digest === null ? null : `sha256:${a.digest ?? sha256(a.bytes)}`,
      browser_download_url: `https://github.com/${r.downloadRepo ?? r.repo}/releases/download/${r.tag}/${a.name}`,
    })),
  });

  const api = (req: FakeRequest): Response | null => {
    const u = new URL(req.url);
    if (u.host !== 'api.github.com') return null;
    counts.api++;
    if (rateLimitReset !== null) {
      return jsonResponse(
        {message: 'API rate limit exceeded'},
        {
          status: 403,
          headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(rateLimitReset)},
        },
      );
    }
    const headers = {'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1999999999'};
    let m = /^\/repositories\/(\d+)\/releases\/tags\/([^/]+)$/.exec(u.pathname);
    if (m !== null) {
      const r = releases.get(`${m[1]}/${decodeURIComponent(m[2]!)}`);
      if (r === undefined) return jsonResponse({message: 'Not Found'}, {status: 404, headers});
      return jsonResponse(releaseJson(r), {headers});
    }
    m = /^\/repositories\/(\d+)\/git\/ref\/tags\/([^/]+)$/.exec(u.pathname);
    if (m !== null) {
      const tag = decodeURIComponent(m[2]!);
      const entry = [...tags.entries()].find(
        ([k, v]) => v.repoId === Number(m![1]) && k.endsWith(`/${tag}`),
      )?.[1];
      if (entry === undefined) return jsonResponse({message: 'Not Found'}, {status: 404, headers});
      const object =
        entry.tagObject === undefined
          ? {type: 'commit', sha: entry.commit}
          : {type: 'tag', sha: entry.tagObject};
      return jsonResponse({ref: `refs/tags/${tag}`, object}, {headers});
    }
    m = /^\/repositories\/(\d+)\/git\/tags\/([0-9a-f]{40})$/.exec(u.pathname);
    if (m !== null) {
      const entry = [...tags.values()].find(v => v.tagObject === m![2]);
      if (entry === undefined) return jsonResponse({message: 'Not Found'}, {status: 404, headers});
      return jsonResponse({sha: m[2], object: {type: 'commit', sha: entry.commit}}, {headers});
    }
    return jsonResponse({message: 'Not Found'}, {status: 404, headers});
  };

  const web = (req: FakeRequest): Response | null => {
    const u = new URL(req.url);
    if (u.host === 'github.com') {
      const m = /^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (m === null) return new Response('not found', {status: 404});
      const r = [...releases.values()].find(
        x => (x.downloadRepo ?? x.repo).toLowerCase() === m[1]!.toLowerCase() && x.tag === m[2],
      );
      const asset = r?.assets.find(a => a.name === decodeURIComponent(m[3]!));
      if (asset === undefined) return new Response('not found', {status: 404});
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://release-assets.githubusercontent.com/github-production-release-asset/${r!.repoId}/${encodeURIComponent(`${r!.tag}/${asset.name}`)}?sig=x`,
        },
      });
    }
    if (u.host === 'release-assets.githubusercontent.com') {
      const m = /^\/github-production-release-asset\/(\d+)\/([^/]+)$/.exec(u.pathname);
      if (m === null) return new Response('not found', {status: 404});
      const [tag, name] = decodeURIComponent(m[2]!).split('/');
      const r = releases.get(`${m[1]}/${tag}`);
      const asset = r?.assets.find(a => a.name === name);
      if (r === undefined || asset === undefined) return new Response('not found', {status: 404});
      counts.download++;
      const bytes = replaced.get(`${r.repo}/${tag}/${name}`) ?? asset.bytes;
      return bytesResponse(bytes, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
        signal: req.init.signal ?? null,
      });
    }
    if (u.host === 'raw.githubusercontent.com') {
      counts.raw++;
      const bytes = raw.get(u.pathname);
      return bytes === undefined
        ? new Response('404: Not Found', {status: 404})
        : new Response(bytes as Uint8Array<ArrayBuffer>, {status: 200});
    }
    return null;
  };

  fake.fallback(req => api(req) ?? web(req));

  return {
    addRelease(r) {
      releases.set(`${r.repoId}/${r.tag}`, r);
    },
    setTag(repo, repoId, tag, value) {
      tags.set(`${repo.toLowerCase()}/${tag}`, {...value, repoId});
    },
    setRaw(repo, commit, path, bytes) {
      raw.set(`/${repo}/${commit}/${path}`, bytes);
    },
    rateLimit(resetSec) {
      rateLimitReset = resetSec;
    },
    serveInstead(repo, tag, asset, bytes) {
      if (bytes === null) replaced.delete(`${repo}/${tag}/${asset}`);
      else replaced.set(`${repo}/${tag}/${asset}`, bytes);
    },
    counts,
  };
}
