import {describe, expect, it} from 'vitest';
import type {CoreBuilder} from '@intactwarden/builders/api.ts';
import type {ReleaseJobResult, ReleaseJobSpec} from '../../src/contracts.ts';
import {
  createInProcessJobHost,
  KEEPALIVE_MS,
  withKeepAlive,
  type JobHost,
} from '../../src/trust/jobHost.ts';
import type {JobProgress} from '../../src/trust/job.ts';

describe('in-process job host', () => {
  it('runs the job in the background context and reports its failure', async () => {
    const progress: JobProgress[] = [];
    const host = createInProcessJobHost({
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
      builder: {} as CoreBuilder,
    });
    const spec = {
      jobId: '0123456789abcdef',
      plan: {repo: 'owner/repo', tag: 'v1.0.0'},
      asset: {name: 'x.zip', sha256: '0'.repeat(64), size: 1},
      configs: [],
    } as unknown as ReleaseJobSpec;
    const result = await host.run(spec, p => progress.push(p));
    expect(result).toEqual({ok: false, failure: 'network'});
    expect(progress.at(-1)?.phase).toBe('failed');
  });
});

describe('keepalive while a job runs (Firefox idle timeout)', () => {
  it('calls a parent API on an interval for the duration of the job, then stops', async () => {
    let pings = 0;
    const ext = {
      runtime: {
        getPlatformInfo: async () => {
          pings++;
          return {os: 'linux', arch: 'x86-64'};
        },
      },
    } as unknown as Parameters<typeof withKeepAlive>[1];
    const ticks: (() => void)[] = [];
    let stopped: unknown = null;
    let finish!: (r: ReleaseJobResult) => void;
    const inner: JobHost = {run: () => new Promise(resolve => (finish = resolve))};
    const host = withKeepAlive(inner, ext, {
      every: (fn, ms) => {
        expect(ms).toBe(KEEPALIVE_MS);
        ticks.push(fn);
        return 'h1';
      },
      stop: h => (stopped = h),
    });
    const running = host.run({} as ReleaseJobSpec, () => undefined);
    expect(ticks).toHaveLength(1);
    ticks[0]!();
    ticks[0]!();
    await Promise.resolve();
    expect(pings).toBe(2);
    expect(stopped).toBeNull();
    const result = {ok: false} as unknown as ReleaseJobResult;
    finish(result);
    expect(await running).toBe(result);
    expect(stopped).toBe('h1');
  });

  it('stops the keepalive when the job throws, and a failing ping never fails the job', async () => {
    let stopped = false;
    const ext = {
      runtime: {
        getPlatformInfo: () => {
          throw new Error('context gone');
        },
      },
    } as unknown as Parameters<typeof withKeepAlive>[1];
    const host = withKeepAlive({run: async () => Promise.reject(new Error('boom'))}, ext, {
      every: fn => {
        fn();
        return 1;
      },
      stop: () => (stopped = true),
    });
    await expect(host.run({} as ReleaseJobSpec, () => undefined)).rejects.toThrow('boom');
    expect(stopped).toBe(true);
  });
});
