/**
 * Anonymous GitHub REST client for deep verify:
 *
 * - every path is addressed by the profile's numeric repository id (`/repositories/<id>/…`), so a
 *   renamed or re-created repository cannot answer;
 * - rate-limit back-off from `x-ratelimit-remaining` / `x-ratelimit-reset` and `retry-after` (and
 *   one minute for a secondary limit without either), between one minute and two hours from now
 *   by this computer's clock, persisted in storage.local `l:v1:github` so a restarted event page
 *   keeps waiting; a stored value that is malformed or further away than two hours is ignored;
 * - `credentials: 'omit'`, `cache: 'no-store'`, response bodies capped.
 */

import {GITHUB_HOSTS, LOCAL_KEYS} from '../contracts.ts';
import {
  GIT_SHA1,
  isRecord,
  isSafeCount,
  TAG_NAME,
  type Kv,
  type TrustLog,
  noLog,
} from './common.ts';
import {readBodyCapped, withDeadline} from './download.ts';

export interface GitHubAsset {
  readonly name: string;
  readonly size: number;
  /** Lowercase hex from GitHub's `digest: "sha256:<hex>"`, or null when GitHub lists none. */
  readonly sha256: string | null;
  readonly downloadUrl: string;
  /** `state === "uploaded"` (or no state reported). */
  readonly uploaded: boolean;
}

export interface GitHubRelease {
  readonly tag: string;
  readonly draft: boolean;
  readonly assets: readonly GitHubAsset[];
}

export interface GitTagRef {
  readonly commit: string;
  readonly tagObject?: string;
}

export type GhResult<T> =
  | {readonly k: 'ok'; readonly value: T}
  | {readonly k: 'not-found'}
  | {readonly k: 'rate-limited'; readonly retryAt: number}
  | {readonly k: 'network'}
  | {readonly k: 'bad-response'};

export interface GitHubClient {
  /** `GET /repositories/<id>/releases/tags/<tag>`. */
  getRelease(repoId: number, tag: string): Promise<GhResult<GitHubRelease>>;
  /** `GET /repositories/<id>/git/ref/tags/<tag>`, peeling annotated tags through `/git/tags/<sha>`. */
  getTagRef(repoId: number, tag: string): Promise<GhResult<GitTagRef>>;
  /** Active back-off, or null. */
  backoffUntil(): number | null;
  /** Loads persisted state (call once before use; later calls are no-ops). */
  load(): Promise<void>;
}

export interface GitHubClientDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly kv: Kv;
  readonly log?: TrustLog;
}

/** Persisted shape of `l:v1:github`. */
interface GitHubState {
  readonly v: 1;
  readonly backoffUntil: number | null;
  /** Consecutive secondary-limit hits (exponential back-off). */
  readonly strikes: number;
}

export const MAX_JSON_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_ASSETS = 500;
const MAX_TAG_DEPTH = 4;
/**
 * Never back off longer than this, whatever a header or a stored value says (clock skew, bad
 * values).
 */
export const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;
/** The shortest back-off, also for a reset time this computer's clock has already passed. */
export const SECONDARY_BACKOFF_MS = 60 * 1000;

const EMPTY: GitHubState = {v: 1, backoffUntil: null, strikes: 0};

function readState(raw: unknown): GitHubState {
  if (!isRecord(raw) || raw['v'] !== 1) return EMPTY;
  const backoff = raw['backoffUntil'];
  const strikes = raw['strikes'];
  return {
    v: 1,
    backoffUntil: isSafeCount(backoff) ? backoff : null,
    strikes: isSafeCount(strikes) && strikes < 32 ? strikes : 0,
  };
}

// Response reduction: only the fields deep verify needs are kept.

function reduceAsset(raw: unknown): GitHubAsset | null {
  if (!isRecord(raw)) return null;
  const {name, size, digest, browser_download_url: url, state} = raw;
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (!isSafeCount(size)) return null;
  if (typeof url !== 'string' || url.length > 2048) return null;
  let sha256: string | null = null;
  if (typeof digest === 'string') {
    const m = /^sha256:([0-9a-f]{64})$/.exec(digest);
    sha256 = m === null ? null : m[1]!;
  }
  return {
    name,
    size,
    sha256,
    downloadUrl: url,
    uploaded: state === undefined || state === 'uploaded',
  };
}

/** Reduces a release JSON object; null when it is not a release. */
export function reduceRelease(raw: unknown): GitHubRelease | null {
  if (!isRecord(raw)) return null;
  const {tag_name: tag, draft, assets} = raw;
  if (typeof tag !== 'string' || !Array.isArray(assets) || assets.length > MAX_ASSETS) return null;
  const reduced: GitHubAsset[] = [];
  for (const a of assets) {
    const r = reduceAsset(a);
    if (r !== null) reduced.push(r);
  }
  return {tag, draft: draft === true, assets: reduced};
}

interface GitObjectRef {
  readonly type: string;
  readonly sha: string;
}

function reduceGitObject(raw: unknown): GitObjectRef | null {
  if (!isRecord(raw) || !isRecord(raw['object'])) return null;
  const {type, sha} = raw['object'];
  if (typeof type !== 'string' || typeof sha !== 'string' || !GIT_SHA1.test(sha)) return null;
  return {type, sha};
}

export function createGitHubClient(deps: GitHubClientDeps): GitHubClient {
  const log = deps.log ?? noLog;
  let state: GitHubState = EMPTY;
  let loaded: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const snapshot = state;
    writing = writing
      .then(() => deps.kv.set(LOCAL_KEYS.github, snapshot))
      .catch(() => log('trust.github.persist-failed'));
    return writing;
  };

  /** The stored back-off while it is in force: in the future, and no further than the cap. */
  const activeBackoff = (): number | null => {
    const until = state.backoffUntil;
    if (until === null) return null;
    const now = deps.now();
    if (until <= now || until > now + MAX_BACKOFF_MS) return null;
    return until;
  };

  const setBackoff = (until: number): number => {
    const now = deps.now();
    const bounded = Math.min(Math.max(until, now + SECONDARY_BACKOFF_MS), now + MAX_BACKOFF_MS);
    const active = activeBackoff();
    if (active !== null && active >= bounded) return active;
    state = {...state, backoffUntil: bounded};
    return bounded;
  };

  /** Back-off from a rate-limited (403/429) response. */
  const rateLimitFrom = (res: Response): number => {
    const now = deps.now();
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter !== null && /^[0-9]{1,6}$/.test(retryAfter.trim())) {
      return now + Number(retryAfter.trim()) * 1000;
    }
    if (remaining === '0' && reset !== null && /^[0-9]{1,12}$/.test(reset.trim())) {
      return Number(reset.trim()) * 1000 + 1000;
    }
    // Secondary limit without headers: at least one minute, doubling per strike.
    const strikes = Math.min(state.strikes, 6);
    state = {...state, strikes: state.strikes + 1};
    return now + SECONDARY_BACKOFF_MS * 2 ** strikes;
  };

  async function getJson<T>(
    path: string,
    reduce: (raw: unknown) => T | null,
  ): Promise<GhResult<T>> {
    await load();
    const back = activeBackoff();
    if (back !== null) return {k: 'rate-limited', retryAt: back};

    const result = await withDeadline(TIMEOUT_MS, async (signal): Promise<GhResult<T>> => {
      let res: Response;
      try {
        res = await deps.fetch(`${GITHUB_HOSTS.api}${path}`, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal,
        });
      } catch {
        return {k: 'network'};
      }
      // Remember an exhausted window even on success, so the next call waits.
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = res.headers.get('x-ratelimit-reset');
        if (reset !== null && /^[0-9]{1,12}$/.test(reset.trim()) && res.status < 400) {
          setBackoff(Number(reset.trim()) * 1000 + 1000);
        }
      }
      if (res.status === 403 || res.status === 429) {
        const until = rateLimitFrom(res);
        void res.body?.cancel().catch(() => undefined);
        return {k: 'rate-limited', retryAt: setBackoff(until)};
      }
      if (res.status === 404 || res.status === 410 || res.status === 451) {
        void res.body?.cancel().catch(() => undefined);
        return {k: 'not-found'};
      }
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => undefined);
        return {k: 'network'};
      }
      const body = await readBodyCapped(res, MAX_JSON_BYTES, signal);
      if (body === null) return {k: 'network'};
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));
      } catch {
        return {k: 'bad-response'};
      }
      const value = reduce(raw);
      if (value === null) return {k: 'bad-response'};
      state = {...state, strikes: 0};
      return {k: 'ok', value};
    });
    await persist();
    if (result.k !== 'ok') log('trust.github.request', {result: result.k});
    return result;
  }

  async function getRelease(repoId: number, tag: string): Promise<GhResult<GitHubRelease>> {
    if (!Number.isSafeInteger(repoId) || repoId < 1 || !TAG_NAME.test(tag)) {
      return {k: 'bad-response'};
    }
    return getJson(
      `/repositories/${repoId}/releases/tags/${encodeURIComponent(tag)}`,
      reduceRelease,
    );
  }

  async function getTagRef(repoId: number, tag: string): Promise<GhResult<GitTagRef>> {
    if (!Number.isSafeInteger(repoId) || repoId < 1 || !TAG_NAME.test(tag)) {
      return {k: 'bad-response'};
    }
    const ref = await getJson(
      `/repositories/${repoId}/git/ref/tags/${encodeURIComponent(tag)}`,
      reduceGitObject,
    );
    if (ref.k !== 'ok') return ref;
    let object = ref.value;
    let tagObject: string | undefined;
    for (let depth = 0; object.type === 'tag'; depth++) {
      if (depth >= MAX_TAG_DEPTH) return {k: 'bad-response'};
      tagObject ??= object.sha;
      const next = await getJson(`/repositories/${repoId}/git/tags/${object.sha}`, reduceGitObject);
      if (next.k !== 'ok') return next.k === 'not-found' ? {k: 'bad-response'} : next;
      object = next.value;
    }
    if (object.type !== 'commit') return {k: 'bad-response'};
    return {
      k: 'ok',
      value: tagObject === undefined ? {commit: object.sha} : {commit: object.sha, tagObject},
    };
  }

  function load(): Promise<void> {
    loaded ??= deps.kv
      .get(LOCAL_KEYS.github)
      .then(raw => {
        state = readState(raw);
      })
      .catch(() => {
        state = EMPTY;
      });
    return loaded;
  }

  return {getRelease, getTagRef, backoffUntil: activeBackoff, load};
}
