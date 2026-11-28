/**
 * Background message handlers of trust and deployments. The router (platform/messaging.ts) has
 * already checked the sender kind; payloads are validated here and refused with `bad-message`.
 */

import type {PermissionStatus, ProfileRegistry, TrustStore, InstanceView} from '../contracts.ts';
import {LOCAL_KEYS} from '../contracts.ts';
import {MessageError, type Router} from '../platform/messaging.ts';
import {createLocalStore} from '../platform/storage.ts';
import type {Ext} from '../platform/webext.ts';
import {isRecord, isReleaseKey} from './common.ts';

const MAX_INPUT = 2048;

function badMessage(): never {
  throw new MessageError('bad-message');
}

function instancePermission(
  statuses: readonly PermissionStatus[],
  origin: string,
): PermissionStatus {
  return (
    statuses.find(s => s.purpose === 'instance' && s.origin === origin) ?? {
      pattern: `${origin}/*`,
      origin,
      purpose: 'instance',
      required: false,
      granted: false,
    }
  );
}

/** With `ext`, UI_LIST_INSTANCES also reports each instance's last build seen (`l:v1:lastSeen`). */
export function registerTrustHandlers(
  router: Router,
  trust: TrustStore,
  registry: ProfileRegistry,
  ext?: Ext,
): void {
  const local = ext === undefined ? null : createLocalStore(ext);

  router.handle('UI_ADD_INSTANCE', async payload => {
    if (
      !isRecord(payload) ||
      typeof payload.input !== 'string' ||
      payload.input.length > MAX_INPUT
    ) {
      badMessage();
    }
    return registry.addInstance({input: payload.input});
  });

  router.handle('UI_REMOVE_INSTANCE', async payload => {
    if (
      !isRecord(payload) ||
      typeof payload.id !== 'string' ||
      !/^[0-9a-f]{16}$/.test(payload.id)
    ) {
      badMessage();
    }
    await registry.removeInstance(payload.id);
    return null;
  });

  router.handle('UI_LIST_INSTANCES', async () => {
    await registry.ready();
    const [statuses, lastSeen] = await Promise.all([
      registry.permissionStatus(),
      local === null
        ? Promise.resolve(undefined)
        : local.get(LOCAL_KEYS.lastSeen).catch(() => undefined),
    ]);
    return registry.instances().map((record): InstanceView => {
      const seen: unknown = lastSeen?.[record.origin];
      const buildId = isRecord(seen) ? seen['buildId'] : undefined;
      const lastBuild = typeof buildId === 'string' ? buildId : null;
      return {
        record,
        permission: instancePermission(statuses, record.origin),
        lastBuild,
      };
    });
  });

  router.handle('UI_DEEP_VERIFY', async payload => {
    if (!isRecord(payload) || !isReleaseKey(payload.key)) badMessage();
    const {app, variant, version} = payload.key;
    return trust.ensureRelease({key: {app, variant, version}, trigger: 'user'});
  });

  router.handle('UI_GET_TRUST', async () => {
    const snapshot = await trust.ready();
    const [cores, jobs, pins, statuses] = await Promise.all([
      trust.listCores(),
      trust.listJobs(),
      trust.pins(),
      registry.permissionStatus().catch((): readonly PermissionStatus[] => []),
    ]);
    const deepVerify = statuses.filter(s => s.purpose === 'deep-verify');
    return {
      snapshot,
      cores,
      jobs,
      pins,
      githubPermission: deepVerify.length > 0 && deepVerify.every(s => s.granted),
    };
  });
}
