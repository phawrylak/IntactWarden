import {describe, expect, it} from 'vitest';
import type {
  MessageRequest,
  MessageResponse,
  MessageType,
  ProfileRegistry,
  TrustStore,
} from '../../src/contracts.ts';
import {
  MessageError,
  type Handler,
  type Router,
  type SenderContext,
} from '../../src/platform/messaging.ts';
import {registerTrustHandlers} from '../../src/trust/handlers.ts';

/** Captures handlers (the real router is tested in test/platform). */
function captureRouter() {
  const handlers = new Map<MessageType, Handler<MessageType>>();
  const router: Router = {
    handle(type, handler) {
      handlers.set(type, handler as unknown as Handler<MessageType>);
    },
    start() {},
  };
  const page: SenderContext = {
    kind: 'page',
    tab: null,
    frame: null,
    url: null,
  };
  const call = <T extends MessageType>(type: T, payload: unknown): Promise<MessageResponse<T>> =>
    (handlers.get(type) as unknown as Handler<T>)(payload as MessageRequest<T>, page);
  return {router, handlers, call};
}

function stubs() {
  const calls: string[] = [];
  const trust = {
    ready: async () => ({ready: true, loaded: true, githubBackoffUntil: null}),
    listCores: async () => [],
    listJobs: async () => [],
    pins: async () => ({schema: 'intactwarden.localpins/1', pins: []}),
    ensureRelease: async (req: unknown) => {
      calls.push(`ensure ${JSON.stringify(req)}`);
      return {ok: true, refs: []};
    },
  } as unknown as TrustStore;
  const registry = {
    ready: async () => undefined,
    addInstance: async (req: unknown) => {
      calls.push(`add ${JSON.stringify(req)}`);
      return {ok: false, code: 'duplicate-instance'};
    },
    removeInstance: async (id: string) => {
      calls.push(`remove ${id}`);
    },
    instances: () => [
      {
        id: '0123456789abcdef',
        app: 'vaultwarden-web',
        origin: 'https://vw.example',
        base_path: '/',
        added_at: 1,
      },
    ],
    permissionStatus: async () => [
      {
        pattern: 'https://github.com/*',
        origin: 'https://github.com',
        purpose: 'deep-verify',
        required: true,
        granted: true,
      },
      {
        pattern: 'https://raw.githubusercontent.com/*',
        origin: 'https://raw.githubusercontent.com',
        purpose: 'deep-verify',
        required: true,
        granted: false,
      },
    ],
  } as unknown as ProfileRegistry;
  return {calls, trust, registry};
}

describe('registerTrustHandlers', () => {
  it('starts a user deep verify with a validated release key', async () => {
    const {router, call} = captureRouter();
    const {calls, trust, registry} = stubs();
    registerTrustHandlers(router, trust, registry);
    await call('UI_DEEP_VERIFY', {
      key: {app: 'vaultwarden-web', variant: 'release', version: '2026.11.0', extra: 1},
    });
    expect(calls).toEqual([
      'ensure {"key":{"app":"vaultwarden-web","variant":"release","version":"2026.11.0"},"trigger":"user"}',
    ]);
    for (const bad of [
      {},
      {key: {app: 'x', variant: 'release', version: '1.0.0'}},
      {key: {app: 'vaultwarden-web', variant: 'release', version: '1.0'}},
    ]) {
      await expect(call('UI_DEEP_VERIFY', bad)).rejects.toBeInstanceOf(MessageError);
    }
  });

  it('builds the trust panel view, with the GitHub permission only when every host is granted', async () => {
    const {router, call} = captureRouter();
    const {trust, registry} = stubs();
    registerTrustHandlers(router, trust, registry);
    const view = await call('UI_GET_TRUST', {});
    expect(view.githubPermission).toBe(false);
    expect(view.snapshot.ready).toBe(true);
    expect(view.pins.schema).toBe('intactwarden.localpins/1');
    expect(Object.keys(view).sort()).toEqual([
      'cores',
      'githubPermission',
      'jobs',
      'pins',
      'snapshot',
    ]);
  });

  it('registers exactly the trust and instance handlers', () => {
    const {router, handlers} = captureRouter();
    const {trust, registry} = stubs();
    registerTrustHandlers(router, trust, registry);
    expect([...handlers.keys()].sort()).toEqual([
      'UI_ADD_INSTANCE',
      'UI_DEEP_VERIFY',
      'UI_GET_TRUST',
      'UI_LIST_INSTANCES',
      'UI_REMOVE_INSTANCE',
    ]);
  });

  it('validates instance payloads before handing them to the registry', async () => {
    const {router, call} = captureRouter();
    const {calls, trust, registry} = stubs();
    registerTrustHandlers(router, trust, registry);
    expect(
      await call('UI_ADD_INSTANCE', {input: 'vw.example', lookalikeConfirmed: false, extra: 1}),
    ).toEqual({ok: false, code: 'duplicate-instance'});
    await call('UI_REMOVE_INSTANCE', {id: '0123456789abcdef'});
    expect(calls).toEqual([
      'add {"input":"vw.example","lookalikeConfirmed":false}',
      'remove 0123456789abcdef',
    ]);
    for (const bad of [
      {input: 'x'.repeat(5000), lookalikeConfirmed: false},
      {input: 'vw.example'},
      {input: 1, lookalikeConfirmed: false},
    ]) {
      await expect(call('UI_ADD_INSTANCE', bad)).rejects.toBeInstanceOf(MessageError);
    }
    await expect(call('UI_REMOVE_INSTANCE', {id: '../x'})).rejects.toBeInstanceOf(MessageError);
    const list = await call('UI_LIST_INSTANCES', {});
    expect(list[0]).toEqual({
      record: expect.objectContaining({id: '0123456789abcdef'}),
      permission: expect.objectContaining({
        origin: 'https://vw.example',
        purpose: 'instance',
        granted: false,
      }),
      lastBuild: null,
    });
  });
});
