/**
 * The profile registry: official origins from @intactwarden/profiles,
 * user-added instances (storage.local `l:v1:instances`), adding an instance, host-permission
 * status, the hint fetch, and content-script registration for instances.
 *
 * Every request is a credential-less GET to the instance the user typed (or a protected origin),
 * with no redirects followed. A hint only selects which release to check; it is never a verdict.
 */

import {APP_PROFILES, OFFICIAL_ORIGINS, profileByApp} from '@intactwarden/profiles';
import type {AppDeployment, AppProfile} from '@intactwarden/core/schema/profile.ts';
import {
  GITHUB_PERMISSION_PATTERNS,
  LOCAL_KEYS,
  type AddInstanceRequest,
  type AddInstanceResult,
  type HintResult,
  type InstanceRecord,
  type Origin,
  type PermissionStatus,
  type ProfileRegistry,
  type ProtectedOrigin,
  type ProtectedOrigins,
  type Unsubscribe,
} from '../contracts.ts';
import {errorName, logWarn} from '../platform/guard.ts';
import {broadcast} from '../platform/messaging.ts';
import {createLocalStore} from '../platform/storage.ts';
import type {Ext} from '../platform/webext.ts';
import {isRecord, randomId, VERSION_XYZ} from '../trust/common.ts';
import {readBodyCapped, withDeadline} from '../trust/download.ts';
import {matchPatternFor, parseInstanceInput} from './serverAddress.ts';

export interface RegistryDeps {
  readonly ext: Ext;
  /** Instance and hint requests: credential-less same-origin GETs only. */
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

const HINT_INTERVAL_MS = 60_000;
/** A request that has not answered by then failed. */
const REQUEST_TIMEOUT_MS = 10_000;
/** `api/config` and hint answers are small JSON documents; a larger body is refused unread. */
const MAX_JSON_BYTES = 64 * 1024;
const CONTENT_SCRIPT_PREFIX = 'iw-inst-';

function selfHosted(p: AppProfile): AppDeployment | undefined {
  return p.deployments.find(d => d.kind === 'self-hosted');
}

function isInstance(v: unknown): v is InstanceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<InstanceRecord>;
  return (
    typeof r.id === 'string' &&
    (r.app === 'bitwarden-web' || r.app === 'vaultwarden-web') &&
    typeof r.origin === 'string' &&
    typeof r.base_path === 'string' &&
    r.base_path.startsWith('/') &&
    r.base_path.endsWith('/') &&
    typeof r.added_at === 'number'
  );
}

export function createRegistry(deps: RegistryDeps): ProfileRegistry {
  const {ext, now} = deps;
  const local = createLocalStore(ext);
  let instances: InstanceRecord[] = [];
  /** Host patterns Firefox grants, by `permissions.contains` (which also sees a wildcard grant). */
  let granted = new Set<string>();
  let current: ProtectedOrigins = {origins: []};
  let byOrigin = new Map<Origin, ProtectedOrigin>();
  const listeners = new Set<(o: ProtectedOrigins) => void>();
  const hints = new Map<Origin, HintResult>();
  /** Hint fetches in flight: concurrent callers for one origin share one request. */
  const hintsInFlight = new Map<Origin, Promise<HintResult>>();

  const has = (pattern: string): boolean => granted.has(pattern);

  const recompute = (): void => {
    const origins: ProtectedOrigin[] = [];
    for (const p of APP_PROFILES) {
      for (const d of p.deployments) {
        if (d.origins === 'user') continue;
        for (const o of d.origins) {
          origins.push({
            origin: o,
            app: p.app as InstanceRecord['app'],
            profile: p,
            deployment: d,
            basePath: '/',
            kind: 'official',
            instance: null,
            granted: has(`${o}/*`),
          });
        }
      }
    }
    for (const i of instances) {
      const p = profileByApp(i.app);
      const d = p === undefined ? undefined : selfHosted(p);
      if (p === undefined || d === undefined) continue;
      origins.push({
        origin: i.origin,
        app: i.app,
        profile: p,
        deployment: d,
        basePath: i.base_path,
        kind: 'instance',
        instance: i,
        granted: has(matchPatternFor(i.origin)),
      });
    }
    current = Object.freeze({origins: Object.freeze(origins)});
    byOrigin = new Map(origins.map(o => [o.origin, o]));
  };

  const notify = (): void => {
    for (const l of listeners) {
      try {
        l(current);
      } catch (e) {
        logWarn('registry-listener', {error: errorName(e)});
      }
    }
  };

  const refreshPermissions = async (): Promise<void> => {
    const patterns = [
      ...OFFICIAL_ORIGINS.map(o => `${o}/*`),
      ...GITHUB_PERMISSION_PATTERNS,
      ...instances.map(i => matchPatternFor(i.origin)),
    ];
    const held = await Promise.all(
      patterns.map(p => ext.permissions.contains({origins: [p]}).catch(() => false)),
    );
    granted = new Set(patterns.filter((_, i) => held[i]));
  };

  const loadInstances = async (): Promise<void> => {
    // One retry: while the list cannot be read, its servers are not protected (no filter at all).
    const raw = await local.get(LOCAL_KEYS.instances).catch(() => local.get(LOCAL_KEYS.instances));
    instances = Array.isArray(raw) ? raw.filter(isInstance) : [];
  };

  const registerContentScripts = async (): Promise<void> => {
    try {
      const existing = await ext.scripting.getRegisteredContentScripts();
      const ours = existing.filter(s => s.id.startsWith(CONTENT_SCRIPT_PREFIX)).map(s => s.id);
      if (ours.length > 0) await ext.scripting.unregisterContentScripts({ids: ours});
      const scripts = instances
        .filter(i => has(matchPatternFor(i.origin)))
        .map(i => ({
          id: CONTENT_SCRIPT_PREFIX + i.id,
          matches: [matchPatternFor(i.origin)],
          js: ['content.js'],
          allFrames: true,
          runAt: 'document_start' as const,
          persistAcrossSessions: true,
        }));
      if (scripts.length > 0) await ext.scripting.registerContentScripts(scripts);
    } catch (e) {
      logWarn('content-scripts', {error: errorName(e)});
    }
  };

  recompute();
  const ready = (async () => {
    try {
      await loadInstances();
    } finally {
      // An unreadable instance list must not leave the official origins ungranted: the
      // backend reads this snapshot to decide what to filter. `ready` still rejects.
      await refreshPermissions();
      recompute();
    }
    await registerContentScripts();
  })();

  const onPermissions = (): void => {
    void (async () => {
      await refreshPermissions();
      recompute();
      await registerContentScripts();
      notify();
    })();
  };
  ext.permissions.onAdded.addListener(onPermissions);
  ext.permissions.onRemoved.addListener(onPermissions);

  /** GET of a small JSON document: its JSON (undefined when not JSON or not 2xx), or 'error'. */
  const getJson = (origin: Origin, basePath: string, path: string): Promise<unknown> =>
    withDeadline(REQUEST_TIMEOUT_MS, async signal => {
      const res = await deps.fetch(origin + basePath + path, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: {accept: 'application/json'},
        signal,
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = await readBodyCapped(res, MAX_JSON_BYTES, signal);
      if (body === null) throw new Error('body');
      try {
        return JSON.parse(new TextDecoder().decode(body)) as unknown;
      } catch {
        return undefined;
      }
    }).catch(() => 'error' as const);

  const hintFor = async (
    origin: Origin,
    basePath: string,
    profile: AppProfile,
  ): Promise<HintResult> => {
    const endpoint = profile.identify.hint_endpoints?.[0];
    const json =
      endpoint === undefined
        ? undefined
        : await getJson(origin, basePath, endpoint.replace(/^\//, ''));
    const v = isRecord(json) ? json['version'] : undefined;
    // Only a version a release key can carry: any other hint is no version (trust/common.ts).
    return {version: typeof v === 'string' && VERSION_XYZ.test(v) ? v : null, at: now()};
  };

  const registry: ProfileRegistry = {
    ready: () => ready,
    lookup: origin => byOrigin.get(origin) ?? null,
    protectedOrigins: () => current,
    instances: () => instances,

    async addInstance(req: AddInstanceRequest): Promise<AddInstanceResult> {
      await ready;
      const parsed = parseInstanceInput(req.input);
      if (!parsed.ok) return {ok: false, code: parsed.code};
      const duplicate = (): boolean => instances.some(i => i.origin === parsed.origin);
      if (duplicate()) return {ok: false, code: 'duplicate-instance'};
      const permitted = await ext.permissions
        .contains({origins: [matchPatternFor(parsed.origin)]})
        .catch(() => false);
      if (!permitted) return {ok: false, code: 'permission-denied'};
      // One request tells the two apps apart: Vaultwarden names itself in `server.name`.
      const config = await getJson(parsed.origin, parsed.basePath, 'api/config');
      if (config === 'error') return {ok: false, code: 'unreachable'};
      if (!isRecord(config) || config['object'] !== 'config' || !isRecord(config['environment'])) {
        return {ok: false, code: 'no-server'};
      }
      const server = config['server'];
      const vaultwarden = isRecord(server) && server['name'] === 'Vaultwarden';
      if (duplicate()) return {ok: false, code: 'duplicate-instance'};
      const instance: InstanceRecord = {
        id: randomId(),
        app: vaultwarden ? 'vaultwarden-web' : 'bitwarden-web',
        origin: parsed.origin,
        base_path: parsed.basePath,
        added_at: now(),
      };
      instances = [...instances, instance];
      await local.set(LOCAL_KEYS.instances, instances);
      await refreshPermissions();
      recompute();
      await registerContentScripts();
      notify();
      broadcast(ext, 'INSTANCES_UPDATED', {});
      return {ok: true, instance};
    },

    async removeInstance(id) {
      await ready;
      const before = instances.length;
      instances = instances.filter(i => i.id !== id);
      if (instances.length === before) return;
      await local.set(LOCAL_KEYS.instances, instances);
      recompute();
      await registerContentScripts();
      notify();
      broadcast(ext, 'INSTANCES_UPDATED', {});
    },

    async fetchHint(origin) {
      const prev = hints.get(origin.origin);
      if (prev !== undefined && now() - prev.at < HINT_INTERVAL_MS) return prev;
      const running = hintsInFlight.get(origin.origin);
      if (running !== undefined) return running;
      const run = hintFor(origin.origin, origin.basePath, origin.profile)
        .then(r => {
          hints.set(origin.origin, r);
          return r;
        })
        .finally(() => hintsInFlight.delete(origin.origin));
      hintsInFlight.set(origin.origin, run);
      return run;
    },

    async permissionStatus() {
      await ready;
      await refreshPermissions();
      const out: PermissionStatus[] = [];
      for (const o of OFFICIAL_ORIGINS) {
        const pattern = `${o}/*`;
        out.push({pattern, origin: o, purpose: 'official', required: true, granted: has(pattern)});
      }
      for (const pattern of GITHUB_PERMISSION_PATTERNS) {
        out.push({
          pattern,
          origin: pattern.slice(0, -'/*'.length),
          purpose: 'deep-verify',
          required: true,
          granted: has(pattern),
        });
      }
      for (const i of instances) {
        const pattern = matchPatternFor(i.origin);
        out.push({
          pattern,
          origin: i.origin,
          purpose: 'instance',
          required: false,
          granted: has(pattern),
        });
      }
      return out;
    },

    onChange(listener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return registry;
}
