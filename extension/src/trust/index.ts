/**
 * Wires the local trust store to the extension: package
 * files, storage.local, the GitHub client and the deep-verify job host. background/main.ts calls
 * the factory synchronously at wake-up.
 *
 * No request is made on a timer of its own: every request is caused by a page that shows a release
 * the extension does not have (its retries included), or a user-started deep verify. The one
 * interval here is the job host's keep-alive (jobHost.ts): an extension API call every 10 s while a
 * job runs.
 */

import type {CoreBuilder} from '@intactwarden/builders/api.ts';
import {
  GITHUB_PERMISSION_PATTERNS,
  type DeepVerifyJobView,
  type ExtensionDb,
  type LocalStorageSchema,
} from '../contracts.ts';
import {broadcast} from '../platform/messaging.ts';
import {logWarn} from '../platform/guard.ts';
import {createLocalStore} from '../platform/storage.ts';
import type {Ext} from '../platform/webext.ts';
import type {PackageReader} from './bootstrap.ts';
import type {Kv, TrustLog} from './common.ts';
import {readBodyCapped} from './download.ts';
import {BUILDER_FINGERPRINT} from './fingerprint.ts';
import {createGitHubClient} from './github.ts';
import {createInProcessJobHost, withKeepAlive} from './jobHost.ts';
import {createLocalTrustStore, type LocalTrustStore} from './store.ts';

export interface TrustStoreDeps {
  readonly ext: Ext;
  readonly db: ExtensionDb;
  readonly builder: CoreBuilder;
  /** GitHub, raw and asset downloads and package files go through it (credentials: 'omit'). */
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/** Package data (a test package's index and cores) is small; anything larger is refused. */
const MAX_PACKAGE_FILE = 32 * 1024 * 1024;

function packageReader(ext: Ext, fetchFn: typeof fetch): PackageReader {
  return async path => {
    let res: Response;
    try {
      res = await fetchFn(ext.runtime.getURL(path), {cache: 'no-store', credentials: 'omit'});
    } catch {
      return null;
    }
    if (!res.ok) return null;
    return readBodyCapped(res, MAX_PACKAGE_FILE);
  };
}

function storageKv(ext: Ext): Kv {
  const local = createLocalStore(ext);
  return {
    get: key => local.get(key as keyof LocalStorageSchema),
    set: (key, value) =>
      local.set(
        key as keyof LocalStorageSchema,
        value as LocalStorageSchema[keyof LocalStorageSchema],
      ),
  };
}

export function createTrustStore(deps: TrustStoreDeps): LocalTrustStore {
  const {ext} = deps;
  const log: TrustLog = (code, detail) => logWarn(code, detail);
  const kv = storageKv(ext);
  const jobHost = withKeepAlive(
    createInProcessJobHost({fetch: deps.fetch, builder: deps.builder}),
    ext,
  );
  const github = createGitHubClient({fetch: deps.fetch, now: deps.now, kv, log});
  const store = createLocalTrustStore({
    kv,
    db: deps.db,
    builder: deps.builder,
    builderFingerprint: BUILDER_FINGERPRINT,
    now: deps.now,
    jobHost,
    github,
    readPackageFile: packageReader(ext, deps.fetch),
    hasGitHubPermission: () =>
      ext.permissions.contains({origins: [...GITHUB_PERMISSION_PATTERNS]}).catch(() => false),
    publishJob: (job: DeepVerifyJobView) => broadcast(ext, 'JOB_UPDATED', {job}),
    log,
  });
  ext.permissions.onAdded.addListener(() => store.permissionsChanged());
  return store;
}
